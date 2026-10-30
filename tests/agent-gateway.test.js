import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import WebSocket from 'ws';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { AgentGateway } from '../src/agent/gateway.js';

let server;
let gateway;
let baseUrl;
let clock;
let allowed;
let events;
const alice = { handle: 'alice', messages: ['Alice private history'] };
const bob = { handle: 'bob', messages: ['Bob private history'] };

beforeEach(async () => {
    clock = 1000;
    allowed = true;
    events = new EventEmitter();
    gateway = new AgentGateway({
        now: () => clock,
        authorize: async () => allowed,
        snapshot: (subject, session) => {
            if (session !== 'main' && session !== 'qq:group:team') throw new Error('Invalid session.');
            return { handle: subject.handle, session: { key: session, messages: subject.messages } };
        },
        dispatch: (subject, method, params) => {
            if (method !== 'message') throw new Error('Unknown method.');
            subject.messages = [...subject.messages, params.text];
            events.emit(subject.handle);
            return { accepted: true };
        },
        subscribe: (subject, listener) => {
            events.on(subject.handle, listener);
            return () => events.off(subject.handle, listener);
        },
    });
    server = http.createServer((req, res) => res.end());
    gateway.attach(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    baseUrl = `ws://127.0.0.1:${server.address().port}`;
});
afterEach(async () => {
    gateway.close();
    await new Promise(resolve => server.close(resolve));
});

function makeSocket(ticket, origin) {
    const socket = new WebSocket(`${baseUrl}/api/agent/gateway?ticket=${ticket}`, origin ? { origin } : {});
    socket.packets = [];
    socket.on('message', raw => socket.packets.push(JSON.parse(raw.toString())));
    return socket;
}

async function waitPacket(socket, predicate) {
    const existing = socket.packets.find(predicate);
    if (existing) return existing;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.off('message', receive); reject(new Error('Gateway did not push a packet.')); }, 3000);
        function receive(raw) {
            const packet = JSON.parse(raw.toString());
            if (!predicate(packet)) return;
            clearTimeout(timer);
            socket.off('message', receive);
            resolve(packet);
        }
        socket.on('message', receive);
    });
}

describe('authenticated ST agent WebSocket gateway', () => {
    test('pushes only the connected account history and accepts messages without HTTP polling', async () => {
        const first = makeSocket(gateway.issue(alice, 'http://st.test').ticket);
        const second = makeSocket(gateway.issue(bob, 'http://st.test').ticket);
        await Promise.all([once(first, 'open'), once(second, 'open')]);
        const a = await waitPacket(first, x => x.type === 'snapshot');
        const b = await waitPacket(second, x => x.type === 'snapshot');
        expect(JSON.stringify(a)).toContain('Alice private history');
        expect(JSON.stringify(a)).not.toContain('Bob private history');
        expect(JSON.stringify(b)).not.toContain('Alice private history');
        first.send(JSON.stringify({ id: 'request-1', method: 'message', params: { text: 'Direct gateway turn' } }));
        expect(await waitPacket(first, x => x.id === 'request-1')).toEqual({ type: 'response', id: 'request-1', ok: true, result: { accepted: true } });
        const pushed = await waitPacket(first, x => x.type === 'snapshot' && x.session.messages.includes('Direct gateway turn'));
        expect(pushed.handle).toBe('alice');
        expect(second.packets.some(x => JSON.stringify(x).includes('Direct gateway turn'))).toBe(false);
    });

    test('tickets are single-use, expire, and enforce browser origins', async () => {
        const issued = gateway.issue(alice, 'http://st.test');
        const first = makeSocket(issued.ticket, 'http://st.test');
        await once(first, 'open');
        const replay = makeSocket(issued.ticket);
        await expect(once(replay, 'open')).rejects.toThrow('401');
        const expired = gateway.issue(alice, 'http://st.test');
        clock += 30001;
        await expect(once(makeSocket(expired.ticket), 'open')).rejects.toThrow('401');
        const otherOrigin = makeSocket(gateway.issue(alice, 'http://st.test').ticket, 'http://evil.test');
        await expect(once(otherOrigin, 'open')).rejects.toThrow('401');
    });

    test('changes subscriptions with validation and rejects malformed methods without crashing', async () => {
        const socket = makeSocket(gateway.issue(alice, 'http://st.test').ticket);
        await once(socket, 'open');
        socket.send(JSON.stringify({ id: 'group', method: 'subscribe', params: { session: 'qq:group:team' } }));
        expect((await waitPacket(socket, x => x.id === 'group')).ok).toBe(true);
        expect((await waitPacket(socket, x => x.type === 'snapshot' && x.session.key === 'qq:group:team')).session.key).toBe('qq:group:team');
        socket.send(JSON.stringify({ id: 'bad', method: 'subscribe', params: { session: '../../other-account' } }));
        expect((await waitPacket(socket, x => x.id === 'bad')).ok).toBe(false);
        socket.send(JSON.stringify({ id: 'unknown', method: 'exec', params: {} }));
        expect((await waitPacket(socket, x => x.id === 'unknown')).ok).toBe(false);
    });

    test('revokes sockets and tickets when account access is removed', async () => {
        const socket = makeSocket(gateway.issue(alice, 'http://st.test').ticket);
        await once(socket, 'open');
        const unused = gateway.issue(alice, 'http://st.test');
        const closing = once(socket, 'close');
        gateway.revoke(alice);
        expect((await closing)[0]).toBe(1008);
        await expect(once(makeSocket(unused.ticket), 'open')).rejects.toThrow('401');
    });

    test('rechecks account authorization before commands', async () => {
        const socket = makeSocket(gateway.issue(alice, 'http://st.test').ticket);
        await once(socket, 'open');
        allowed = false;
        const closing = once(socket, 'close');
        socket.send(JSON.stringify({ id: 'revoked', method: 'message', params: { text: 'Unauthorized turn' } }));
        expect((await closing)[0]).toBe(1008);
    });
});
