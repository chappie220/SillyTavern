import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { QQBot } from '../src/agent/qq.js';

const bots = [];
afterEach(() => bots.splice(0).forEach(bot => bot.stop()));

class FakeSocket extends EventEmitter {
    constructor(url) {
        super();
        this.url = url;
        this.sent = [];
    }
    send(value) { this.sent.push(JSON.parse(value)); }
    terminate() { this.emit('close', 1006); }
}

function createBot({ onEvent = jest.fn(), sandbox = false, fetchImpl } = {}) {
    const requests = [];
    const fetchMock = fetchImpl ?? jest.fn(async (url, options) => {
        requests.push({ url, options });
        const data = url.includes('getAppAccessToken') ? { access_token: 'test-access-token', expires_in: 7200 }
            : url.endsWith('/gateway') ? { url: 'wss://gateway.example.test' } : { id: 'message-result' };
        return { ok: true, status: 200, json: async () => data };
    });
    const bot = new QQBot({ appId: '1234', sandbox }, { getSecret: () => 'test-secret', onEvent, fetchImpl: fetchMock, WebSocketImpl: FakeSocket });
    bot.stopped = false;
    bots.push(bot);
    return { bot, requests, onEvent, fetchMock };
}

describe('QQ official transport', () => {
    test('uses the official token endpoint, identifies with the bot token, and resumes an existing session', async () => {
        const { bot, requests } = createBot();
        await bot.connect();
        expect(requests[0].url).toBe('https://bots.qq.com/app/getAppAccessToken');
        expect(JSON.parse(requests[0].options.body)).toEqual({ appId: '1234', clientSecret: 'test-secret' });
        expect(requests[1].options.headers.Authorization).toBe('QQBot test-access-token');
        await bot.frame({ op: 10, d: { heartbeat_interval: 30000 } }, bot.socket);
        expect(bot.socket.sent[0]).toEqual(expect.objectContaining({ op: 2, d: expect.objectContaining({ token: 'QQBot test-access-token', intents: 1 << 25 }) }));
        await bot.frame({ op: 0, t: 'READY', s: 1, d: { session_id: 'session-1' } }, bot.socket);
        expect(bot.status.state).toBe('connected');
        await bot.frame({ op: 10, d: { heartbeat_interval: 30000 } }, bot.socket);
        expect(bot.socket.sent.at(-1)).toEqual({ op: 6, d: { token: 'QQBot test-access-token', session_id: 'session-1', seq: 1 } });
        expect(JSON.stringify(bot.status)).not.toContain('token');
    });

    test('normalizes private and group events and advances sequence only after admission', async () => {
        const { bot, onEvent } = createBot();
        const socket = new FakeSocket();
        await bot.frame({ op: 0, s: 2, t: 'C2C_MESSAGE_CREATE', d: { id: 'm1', content: ' Hi ', author: { user_openid: 'owner' } } }, socket);
        await bot.frame({ op: 0, s: 3, t: 'GROUP_AT_MESSAGE_CREATE', d: { id: 'm2', content: '<@!12345> Hello team', group_openid: 'team', author: { member_openid: 'member' } } }, socket);
        expect(onEvent.mock.calls.map(x => x[0])).toEqual([
            { id: 'm1', sender: 'owner', groupId: undefined, text: 'Hi' },
            { id: 'm2', sender: 'member', groupId: 'team', text: 'Hello team' },
        ]);
        onEvent.mockImplementationOnce(() => { throw new Error('Disk full'); });
        await expect(bot.frame({ op: 0, s: 4, t: 'C2C_MESSAGE_CREATE', d: { id: 'm3', content: 'Save me', author: { user_openid: 'owner' } } }, socket)).rejects.toThrow('Disk full');
        expect(bot.sequence).toBe(3);
    });

    test('sends passive replies with stable message sequences and resumes after the last delivered chunk', async () => {
        const { bot, requests } = createBot({ sandbox: true });
        const progress = jest.fn();
        await bot.sendText({ kind: 'c2c', id: 'owner', messageId: 'original' }, '🙂'.repeat(3300), 1, progress);
        const outbound = requests.filter(x => x.url.includes('/v2/users/'));
        expect(outbound).toHaveLength(2);
        expect(outbound[0].url).toBe('https://sandbox.api.sgroup.qq.com/v2/users/owner/messages');
        expect(JSON.parse(outbound[0].options.body)).toEqual({ content: '🙂'.repeat(1500), msg_type: 0, msg_id: 'original', msg_seq: 2 });
        expect(progress.mock.calls).toEqual([[2], [3]]);
    });

    test('group and proactive delivery use the correct API and omit passive-only fields', async () => {
        const { bot, requests } = createBot();
        await bot.sendText({ kind: 'group', id: 'team' }, 'Reminder');
        const request = requests.at(-1);
        expect(request.url).toBe('https://api.sgroup.qq.com/v2/groups/team/messages');
        expect(JSON.parse(request.options.body)).toEqual({ content: 'Reminder', msg_type: 0 });
    });

    test('invalidates sessions after opcode 9 and reports authentication failures without secret text', async () => {
        const { bot } = createBot();
        bot.sessionId = 'old';
        bot.sequence = 4;
        await bot.frame({ op: 9 }, new FakeSocket());
        expect(bot.sessionId).toBeNull();
        expect(bot.sequence).toBeNull();
        const broken = createBot({ fetchImpl: async () => { throw new Error('network failure test-secret'); } }).bot;
        await broken.connect();
        expect(broken.status.error).not.toContain('test-secret');
        expect(broken.status.state).toBe('reconnecting');
    });

    test('retries a 401 with a fresh token', async () => {
        let tokens = 0;
        let apiCalls = 0;
        const fetchImpl = jest.fn(async url => {
            if (url.includes('getAppAccessToken')) return { ok: true, json: async () => ({ access_token: `token-${++tokens}`, expires_in: 7200 }) };
            apiCalls++;
            return { ok: apiCalls > 1, status: apiCalls > 1 ? 200 : 401, json: async () => ({ id: 'sent' }) };
        });
        const { bot } = createBot({ fetchImpl });
        await bot.sendText({ kind: 'c2c', id: 'owner' }, 'Hi');
        expect(tokens).toBe(2);
        expect(apiCalls).toBe(2);
    });
});
