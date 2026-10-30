import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { AgentStore, validateConfig } from '../src/agent/store.js';
import { AgentRuntime } from '../src/agent/runtime.js';

process.env.SILLYTAVERN_BACKUPS_CHAT_ENABLED = 'false';
process.env.SILLYTAVERN_BACKUPS_CHAT_MAXTOTALBACKUPS = '-1';
process.env.SILLYTAVERN_BACKUPS_CHAT_THROTTLEINTERVAL = '0';
process.env.SILLYTAVERN_BACKUPS_CHAT_CHECKINTEGRITY = 'true';
let trySaveChat;
beforeAll(async () => { ({ trySaveChat } = await import('../src/endpoints/chats.js')); });

let root, file, store, agent, generate;
const target = { avatar: 'Character.png', file: 'Daily chat' };
const read = () => fs.readFileSync(file, 'utf8').split('\n').map(line => JSON.parse(line));
const document = () => { const saved = store.chat.document(); return [saved.header, ...saved.messages]; };
async function drain() {
    for (let index = 0; index < 10; index++) {
        await agent.work;
        if (!store.state.queue.length) break;
        agent.tick();
    }
}

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-native-agent-'));
    file = path.join(root, 'chats', 'Character', 'Daily chat.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
        { chat_metadata: { integrity: 'existing-integrity', note: 'keep this' }, user_name: 'unused', character_name: 'unused' },
        { name: 'Character', is_user: false, mes: 'An existing greeting.', send_date: '2026-01-01', extra: { custom: 'preserved' }, swipes: ['An existing greeting.', 'Another greeting.'], swipe_id: 0 },
        { name: 'Me', is_user: true, mes: 'Remember our daily conversation.', send_date: '2026-01-02', extra: {} },
        { name: 'Character', is_user: false, mes: 'I remember.', send_date: '2026-01-02', extra: {} },
    ].map(row => JSON.stringify(row)).join('\n'));
    store = new AgentStore(root);
    store.saveConfig(validateConfig({ enabled: true, binding: { name: 'Character', character: target.avatar, chat: target, systemMessages: [{ role: 'system', content: 'Stay in character.' }] }, qq: { enabled: true, appId: '1234', ownerOpenId: 'owner' } }));
    generate = jest.fn(async () => 'A gateway reply.');
    agent = new AgentRuntime(store, { generate, createQQ: () => ({ start() {}, stop() {}, sendText: async () => {}, status: {} }) });
    agent.start();
});
afterEach(async () => {
    await agent.stop();
    store.chat.close();
    fs.rmSync(root, { recursive: true, force: true });
});

describe('main is an ordinary SillyTavern character chat', () => {
    test('uses existing history and native metadata, and QQ replies survive a restart without a browser', async () => {
        expect(store.session().messages.map(message => message.content)).toEqual(['An existing greeting.', 'Remember our daily conversation.', 'I remember.']);
        agent.receiveQQ({ id: 'qq-message', sender: 'owner', text: 'A QQ private message.' });
        await drain();
        const data = read();
        expect(data.slice(-2).map(message => message.mes)).toEqual(['A QQ private message.', 'A gateway reply.']);
        expect(data[0].chat_metadata).toMatchObject({ integrity: 'existing-integrity', note: 'keep this' });
        expect(data[1]).toMatchObject({ extra: { custom: 'preserved' }, swipes: ['An existing greeting.', 'Another greeting.'] });
        expect(JSON.stringify(generate.mock.calls[0][0])).toContain('Remember our daily conversation.');
        await agent.stop();
        store.chat.close();
        store = new AgentStore(root);
        expect(store.session().messages).toHaveLength(5);
        expect(read()).toEqual(data);
    });

    test('native edits and deletions change the next gateway context and reset the old summary', async () => {
        const data = document();
        data[2].mes = 'The corrected daily conversation.';
        data.splice(3, 1);
        store.session().summary = 'obsolete summary';
        store.session().summaryUntil = 2;
        const saved = await trySaveChat(data, file, false, 'user', 'Character', root);
        expect(saved.messages).toHaveLength(2);
        expect(store.session().summary).toBe('');
        agent.enqueue({ text: 'Continue here.', source: 'gateway', chat: target });
        await drain();
        const context = JSON.stringify(generate.mock.calls[0][0]);
        expect(context).toContain('The corrected daily conversation.');
        expect(context).not.toContain('Remember our daily conversation.');
        expect(context).not.toContain('I remember.');
    });

    test('a stale tab cannot overwrite newly arrived QQ messages, even with force', async () => {
        const stale = document();
        agent.receiveQQ({ id: 'new-message', sender: 'owner', text: 'Arrived after the browser loaded.' });
        await drain();
        const expected = fs.readFileSync(file, 'utf8');
        stale[1].mes = 'A stale browser edit';
        await expect(trySaveChat(stale, file, true, 'user', 'Character', root)).rejects.toMatchObject({ code: 'agent_conflict' });
        expect(fs.readFileSync(file, 'utf8')).toBe(expected);
    });

    test('regeneration, swipes and continuation update the same native reply', async () => {
        for (const operation of ['regenerate', 'swipe', 'continue']) {
            generate.mockResolvedValueOnce(operation === 'continue' ? ' Continued.' : `${operation} reply`);
            agent.enqueue({ operation, chat: target, source: 'gateway' });
            await drain();
        }
        const data = read();
        expect(data).toHaveLength(4);
        expect(data.at(-1)).toMatchObject({ mes: 'swipe reply Continued.', swipes: ['I remember.', 'regenerate reply', 'swipe reply Continued.'], swipe_id: 2 });
        expect(JSON.stringify(generate.mock.calls[0][0])).not.toContain('I remember.');
        expect(store.state.queue).toHaveLength(0);
    });

    test('an old standalone main is preserved once when binding a daily chat', () => {
        const config = structuredClone(store.config);
        delete config.binding.chat;
        store.saveConfig(config);
        store.state.sessions.main.messages = [{ id: 'old-main', role: 'user', name: 'Me', content: 'Existing agent history', at: '2026-01-01', source: 'gateway' }];
        store.saveConfig({ ...config, binding: { ...config.binding, chat: target } });
        expect(read().at(-1).mes).toBe('Existing agent history');
        store.save();
        store.chat.close();
        store = new AgentStore(root);
        expect(read().filter(message => message.mes === 'Existing agent history')).toHaveLength(1);
    });

    test('reopening a native chat respects its file and never resurrects removed messages', async () => {
        agent.enqueue({ text: 'Remove me while the gateway is down.' });
        await drain();
        await agent.stop();
        const data = read();
        fs.writeFileSync(file, data.slice(0, -2).map(row => JSON.stringify(row)).join('\n'));
        store.chat.close();
        store = new AgentStore(root);
        expect(store.session().messages).toHaveLength(3);
        expect(read()).toHaveLength(4);
    });

    test('the native stop action cancels generation without retrying or discarding the user input', async () => {
        generate.mockImplementationOnce((messages, signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true })));
        const { id } = agent.enqueue({ text: 'Cancel this reply.', source: 'gateway' });
        await Promise.resolve();
        agent.cancel(id);
        await drain();
        expect(store.state.queue).toHaveLength(0);
        expect(read().at(-1).mes).toBe('Cancel this reply.');
        expect(store.state.lastError).toBe('');
        agent.enqueue({ text: 'A subsequent message.', source: 'gateway' });
        await drain();
        expect(read().at(-1).mes).toBe('A gateway reply.');
    });
});
