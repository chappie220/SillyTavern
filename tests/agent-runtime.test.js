import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { AgentStore, DEFAULT_CONFIG, validateConfig } from '../src/agent/store.js';
import { AgentRuntime } from '../src/agent/runtime.js';

let root;
let instances;
let clock;
const binding = { name: 'Assistant', systemMessages: [{ role: 'system', content: 'You are a helpful ST character.' }] };

beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-agent-'));
    instances = [];
    clock = 100000000;
});
afterEach(async () => {
    await Promise.all(instances.map(x => x.stop()));
    fs.rmSync(root, { recursive: true, force: true });
});

function runtime({ generate = jest.fn(async () => 'Reply'), sendText = jest.fn(async () => {}), config = {}, restore = false } = {}) {
    const store = new AgentStore(root);
    if (!restore) store.saveConfig(validateConfig({ ...structuredClone(DEFAULT_CONFIG), enabled: true, binding, ...config }));
    const qq = { start: jest.fn(), stop: jest.fn(), sendText, status: { state: 'connected' } };
    const agent = new AgentRuntime(store, { generate, createQQ: () => qq, now: () => clock });
    instances.push(agent);
    agent.start();
    return { agent, store, generate, qq };
}

async function drain(agent) {
    for (let i = 0; i < 20; i++) {
        await agent.work;
        if (!agent.store.state.queue.some(x => x.retryAt <= clock)) return;
        agent.tick();
    }
    throw new Error('Queue did not drain.');
}

describe('ST persistent agent', () => {
    test('web and owner QQ share main, duplicate events are ignored and history survives a restart', async () => {
        const first = runtime({ config: { qq: { enabled: true, appId: '123', ownerOpenId: 'owner' } } });
        await first.agent.work;
        first.agent.enqueue({ text: 'Remember my name is Alice.' });
        await drain(first.agent);
        await first.agent.stop();
        const second = runtime({ restore: true });
        await second.agent.work;
        second.agent.receiveQQ({ id: 'event-1', sender: 'owner', text: 'What is my name?' });
        second.agent.receiveQQ({ id: 'event-1', sender: 'owner', text: 'What is my name?' });
        await drain(second.agent);
        expect(second.generate).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(second.generate.mock.calls[0][0])).toContain('Alice');
        expect(second.qq.sendText).toHaveBeenCalledTimes(1);
        expect(second.store.session().messages).toHaveLength(4);
        expect(new AgentStore(root).session().messages).toHaveLength(4);
    });

    test('unknown senders only appear in discovery; group history and private memory are isolated', async () => {
        const { agent, store, generate } = runtime({ config: {
            memory: 'Private bank preference', qq: { enabled: true, appId: '123', ownerOpenId: 'owner', allowedGroups: ['team'] },
        } });
        await agent.work;
        agent.receiveQQ({ id: 'stranger', sender: 'stranger', text: 'Read main' });
        expect(agent.status().observedSender.openId).toBe('stranger');
        expect(store.state.queue).toHaveLength(0);
        agent.enqueue({ text: 'A private conversation.' });
        await drain(agent);
        agent.receiveQQ({ id: 'group', sender: 'member', groupId: 'team', text: 'Hello team' });
        await drain(agent);
        const groupPrompt = JSON.stringify(generate.mock.calls[1][0]);
        expect(groupPrompt).not.toContain('private conversation');
        expect(groupPrompt).not.toContain('bank preference');
        expect(groupPrompt).toContain('[member] Hello team');
        expect(store.session('qq:group:team').messages).toHaveLength(2);
        expect(store.session().messages).toHaveLength(2);
        expect(() => store.session('../../secrets')).toThrow();
    });

    test('a failed delivery retries the saved reply without another model call, including after restart', async () => {
        const sendText = jest.fn().mockRejectedValueOnce(new Error('QQ unavailable'));
        const first = runtime({ sendText, config: { qq: { enabled: true, appId: '123', ownerOpenId: 'owner' } } });
        await first.agent.work;
        first.agent.receiveQQ({ id: 'retry-1', sender: 'owner', text: 'Hi' });
        await drain(first.agent);
        expect(first.store.state.queue[0].reply).toBe('Reply');
        await first.agent.stop();
        clock += 30001;
        const second = runtime({ restore: true });
        await drain(second.agent);
        expect(second.generate).not.toHaveBeenCalled();
        expect(second.qq.sendText).toHaveBeenCalledTimes(1);
        expect(second.store.session().messages).toHaveLength(2);
    });

    test('keeps same-session requests ordered while allowing other sessions past a failed job', async () => {
        const generate = jest.fn().mockRejectedValueOnce(new Error('Temporary model failure')).mockResolvedValue('Reply');
        const { agent, store } = runtime({ generate });
        await agent.work;
        agent.enqueue({ id: 'one', text: 'One' });
        agent.enqueue({ id: 'two', text: 'Two' });
        agent.enqueue({ id: 'group', session: 'qq:group:team', text: 'Group' });
        await agent.work;
        agent.tick();
        await agent.work;
        expect(store.session().messages.map(x => x.content)).toEqual(['One']);
        expect(store.session('qq:group:team').messages).toHaveLength(2);
        clock += 30001;
        await drain(agent);
        expect(store.session().messages.map(x => x.content)).toEqual(['One', 'Reply', 'Two', 'Reply']);
    });

    test('restores accepted work when stopped during generation, without duplicating the user message', async () => {
        let started;
        const ready = new Promise(resolve => { started = resolve; });
        const first = runtime({ generate: (messages, signal) => new Promise((resolve, reject) => {
            started();
            signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true });
        }) });
        await first.agent.work;
        first.agent.enqueue({ id: 'unfinished', text: 'Continue after restart' });
        await ready;
        await first.agent.stop();
        const second = runtime({ restore: true });
        await drain(second.agent);
        expect(second.store.session().messages.map(x => x.content)).toEqual(['Continue after restart', 'Reply']);
    });

    test('one-off and periodic schedules survive restart without replaying every missed interval', async () => {
        const task = { id: 'daily', prompt: 'Review plans', at: new Date(clock).toISOString(), intervalMinutes: 1, enabled: true, target: 'main' };
        const first = runtime({ config: { tasks: [task, { ...task, id: 'once', intervalMinutes: 0 }] } });
        await drain(first.agent);
        expect(first.generate).toHaveBeenCalledTimes(2);
        await first.agent.stop();
        const second = runtime({ restore: true });
        await drain(second.agent);
        expect(second.generate).not.toHaveBeenCalled();
        clock += 3600000;
        second.agent.tick();
        await drain(second.agent);
        expect(second.generate).toHaveBeenCalledTimes(1);
        second.agent.tick();
        await drain(second.agent);
        expect(second.generate).toHaveBeenCalledTimes(1);
    });

    test('heartbeats run without a browser and HEARTBEAT_OK is saved silently without QQ delivery', async () => {
        const { agent, store, generate, qq } = runtime({ generate: jest.fn(async () => 'HEARTBEAT_OK'), config: {
            heartbeatMinutes: 1, heartbeatToQQ: true, qq: { enabled: true, appId: '123', ownerOpenId: 'owner' },
        } });
        await agent.work;
        // The persisted timestamp uses real UTC on first creation.
        store.state.lastHeartbeat = clock;
        clock += 60001;
        agent.tick();
        await drain(agent);
        expect(generate).toHaveBeenCalledTimes(1);
        expect(qq.sendText).not.toHaveBeenCalled();
        expect(store.session().messages[1].silent).toBe(true);
    });

    test('summarizes long history while retaining the full durable transcript', async () => {
        const generate = jest.fn(async messages => messages[0].content.startsWith('Update the conversation memory') ? 'Alice has unfinished plans.' : 'New reply');
        const { agent, store } = runtime({ generate, config: { contextChars: 4000 } });
        await agent.work;
        for (let i = 0; i < 14; i++) store.session().messages.push({ id: `old-${i}`, role: i % 2 ? 'assistant' : 'user', content: `Important message ${i} ${'x'.repeat(300)}` });
        agent.enqueue({ text: 'Continue our plans.' });
        await drain(agent);
        expect(store.session().summary).toContain('Alice');
        expect(store.session().summaryUntil).toBeGreaterThan(0);
        expect(new AgentStore(root).session().messages).toHaveLength(16);
        expect(JSON.stringify(generate.mock.calls.at(-1)[0]).length).toBeLessThanOrEqual(4000);
    });
});

describe('agent configuration validation', () => {
    test('rejects malformed schedules and accidental always-on intervals', () => {
        expect(() => validateConfig({ heartbeatMinutes: -1 })).toThrow();
        expect(() => validateConfig({ heartbeatMinutes: NaN })).toThrow();
        expect(() => validateConfig({ tasks: [{ prompt: 'Hi', at: new Date().toISOString(), target: 'main', enabled: true }] })).toThrow();
        expect(() => validateConfig({ enabled: 'false' })).toThrow();
        expect(() => validateConfig({ qq: { enabled: true } })).toThrow();
    });
});
