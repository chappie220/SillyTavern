import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-agent-api-'));
const secrets = new Map();
let enabledUsers = [];
let accountsEnabled = true;
const keyFor = (directories, key) => `${directories.root}:${key}`;

jest.unstable_mockModule('../src/users.js', () => ({
    getAllEnabledUsers: async () => enabledUsers,
    getUserDirectories: handle => ({ root: path.join(root, handle) }),
}));
jest.unstable_mockModule('../src/util.js', () => ({ getConfigValue: () => accountsEnabled }));
jest.unstable_mockModule('../src/endpoints/secrets.js', () => ({
    SECRET_KEYS: { AGENT_QQ: 'qq', AGENT_MODEL_REQUEST: 'model' },
    readSecret: (directories, key) => secrets.get(keyFor(directories, key)),
    writeSecret: (directories, key, value) => secrets.set(keyFor(directories, key), value),
}));
jest.unstable_mockModule('../src/endpoints/backends/chat-completions.js', () => ({
    generateChatCompletion: async (req, res) => res.send({ choices: [{ message: { content: 'Background reply' } }] }),
}));
jest.unstable_mockModule('../src/agent/qq.js', () => ({
    QQBot: class {
        status = { state: 'connected' };
        start() {}
        stop() {}
        async sendText() {}
    },
}));

let endpoint;
beforeAll(async () => {
    fs.mkdirSync(path.join(root, 'alice', 'characters'), { recursive: true });
    fs.writeFileSync(path.join(root, 'alice', 'characters', 'Assistant.json'), JSON.stringify({ data: { name: 'Character', description: 'Character prompt' } }));
    endpoint = await import('../src/endpoints/agent.js');
});
afterAll(async () => {
    await endpoint.onExit();
    fs.rmSync(root, { recursive: true, force: true });
});

async function call(route, { user = 'alice', body = {}, query = {}, method = 'post' } = {}) {
    const layer = endpoint.router.stack.find(x => x.route?.path === route && x.route.methods[method]);
    let data;
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { data = value; } };
    await layer.route.stack[0].handle({ body, query, user: { profile: { handle: user, name: user }, directories: { root: path.join(root, user) } } }, response);
    return { status: response.statusCode, data };
}

describe('ST Agent account-scoped endpoints', () => {
    test('requires binding before start and keeps credentials out of status responses', async () => {
        const initial = (await call('/status', { method: 'get' })).data;
        expect(initial.config.enabled).toBe(false);
        const invalid = await call('/config', { body: { ...initial.config, enabled: true } });
        expect(invalid.status).toBe(400);
        const bind = await call('/bind', { body: {
            character: 'Assistant.json',
            connection: { model: 'test-model', chat_completion_source: 'custom', custom_url: 'https://model.example/v1', proxy_password: 'private-model-secret' },
        } });
        expect(bind.status).toBe(200);
        expect(bind.data.config.binding.mode).toBe('gateway');
        expect(JSON.stringify(bind.data)).not.toContain('private-model-secret');
        const saved = await call('/config', { body: {
            ...bind.data.config, enabled: true, qq: { ...bind.data.config.qq, enabled: true, appId: '1234', ownerOpenId: 'owner' }, qqSecret: 'private-qq-secret',
        } });
        expect(saved.status).toBe(200);
        expect(saved.data.status.running).toBe(true);
        expect(saved.data.hasQQSecret).toBe(true);
        expect(JSON.stringify(saved.data)).not.toContain('private-qq-secret');
        expect(fs.readFileSync(path.join(root, 'alice', 'agent', 'config.json'), 'utf8')).not.toContain('secret');
    });

    test('accepts a main message and isolates other ST accounts', async () => {
        const result = await call('/message', { body: { text: 'A private message' } });
        expect(result.status).toBe(202);
        await new Promise(resolve => setTimeout(resolve, 20));
        const alice = await call('/session', { method: 'get' });
        expect(alice.data.messages.map(x => x.content)).toEqual(['A private message', 'Background reply']);
        const bob = await call('/session', { user: 'bob', method: 'get' });
        expect(bob.data.messages).toEqual([]);
        const state = await call('/status', { user: 'bob', method: 'get' });
        expect(state.data.config.binding).toBeNull();
        expect(state.data.hasQQSecret).toBe(false);
    });

    test('a malformed configuration cannot interrupt an already-running agent', async () => {
        const initial = (await call('/status', { method: 'get' })).data;
        const result = await call('/config', { body: { ...initial.config, heartbeatMinutes: -1 } });
        expect(result.status).toBe(400);
        expect((await call('/status', { method: 'get' })).data.status.running).toBe(true);
        expect((await call('/session', { query: { key: '../../bob' }, method: 'get' })).status).toBe(400);
        expect((await call('/bind', { body: { systemMessages: [{ role: 'system', content: 'Browser snapshot' }], request: {} } })).status).toBe(400);
    });

    test('enabled accounts restore without browser interaction, and disabled accounts stop', async () => {
        const config = JSON.parse(fs.readFileSync(path.join(root, 'alice', 'agent', 'config.json'), 'utf8'));
        fs.mkdirSync(path.join(root, 'restored', 'agent'), { recursive: true });
        fs.writeFileSync(path.join(root, 'restored', 'agent', 'config.json'), JSON.stringify({ ...config, qq: { ...config.qq, enabled: false } }));
        enabledUsers = [{ handle: 'restored', enabled: true }];
        await endpoint.init();
        const restored = await call('/status', { user: 'restored', method: 'get' });
        expect(restored.data.status.running).toBe(true);
        // Alice was stopped and removed by account reconciliation.
        const alice = await call('/status', { method: 'get' });
        expect(alice.data.status.running).toBe(false);
    });

    test('the default user restores when ST user accounts are disabled', async () => {
        const config = JSON.parse(fs.readFileSync(path.join(root, 'alice', 'agent', 'config.json'), 'utf8'));
        fs.mkdirSync(path.join(root, 'default-user', 'agent'), { recursive: true });
        fs.writeFileSync(path.join(root, 'default-user', 'agent', 'config.json'), JSON.stringify({ ...config, qq: { ...config.qq, enabled: false } }));
        accountsEnabled = false;
        enabledUsers = [];
        await endpoint.init();
        const restored = await call('/status', { user: 'default-user', method: 'get' });
        expect(restored.data.status.running).toBe(true);
    });
});
