import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { describe, expect, jest, test } from '@jest/globals';
import { DEFAULT_CONFIG } from '../src/agent/store.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
jest.setTimeout(45000);

async function availablePort() {
    const probe = http.createServer();
    probe.listen(0, '127.0.0.1');
    await once(probe, 'listening');
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    return port;
}

function launch(root, port) {
    const child = spawn(process.execPath, [
        'server.js', '--agentGatewayOnly', '--configPath', path.join(root, 'config.yaml'),
        '--dataRoot', path.join(root, 'data'), '--port', String(port),
    ], { cwd: repository, stdio: ['ignore', 'pipe', 'pipe'] });
    const state = { child, logs: '' };
    state.ready = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Gateway startup timed out:\n${state.logs}`)), 20000);
        const receive = chunk => {
            state.logs += chunk.toString();
            if (state.logs.includes('ST Agent Gateway API:')) { clearTimeout(timer); resolve(); }
        };
        child.stdout.on('data', receive);
        child.stderr.on('data', receive);
        child.once('exit', code => { clearTimeout(timer); reject(new Error(`Gateway exited (${code}):\n${state.logs}`)); });
    });
    return state;
}

async function stop(state) {
    if (!state || state.child.exitCode !== null) return;
    const exiting = once(state.child, 'exit');
    state.child.kill('SIGTERM');
    const force = setTimeout(() => state.child.kill('SIGKILL'), 3000);
    await exiting;
    clearTimeout(force);
}

async function connect(url) {
    const tokenResponse = await fetch(`${url}/csrf-token`);
    const cookies = tokenResponse.headers.getSetCookie().map(x => x.split(';')[0]).join('; ');
    const { token } = await tokenResponse.json();
    const ticketResponse = await fetch(`${url}/api/agent/gateway-ticket`, {
        method: 'POST', headers: { Cookie: cookies, 'X-CSRF-Token': token, 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(ticketResponse.status).toBe(200);
    const { ticket, path: socketPath } = await ticketResponse.json();
    const socket = new WebSocket(`${url.replace('http:', 'ws:')}${socketPath}?ticket=${ticket}`);
    socket.packets = [];
    socket.on('message', value => socket.packets.push(JSON.parse(value.toString())));
    await once(socket, 'open');
    return socket;
}

async function packet(socket, predicate) {
    const existing = socket.packets.find(predicate);
    if (existing) return existing;
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { socket.off('message', receive); reject(new Error('No gateway reply.')); }, 10000);
        const receive = raw => {
            const value = JSON.parse(raw.toString());
            if (!predicate(value)) return;
            clearTimeout(timeout);
            socket.off('message', receive);
            resolve(value);
        };
        socket.on('message', receive);
    });
}

describe('ST gateway without frontend or browser', () => {
    test('loads files, calls the existing model backend, pushes replies, and restores after restart', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-headless-'));
        const user = path.join(root, 'data', 'default-user');
        let processState;
        let socket;
        const requests = [];
        const model = http.createServer(async (req, res) => {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks).toString());
            requests.push(body);
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ choices: [{ message: { content: `Gateway reply ${requests.length}` } }] }));
        });
        model.listen(0, '127.0.0.1');
        await once(model, 'listening');
        try {
            for (const directory of ['characters', 'agent', 'worlds']) fs.mkdirSync(path.join(user, directory), { recursive: true });
            fs.writeFileSync(path.join(root, 'config.yaml'), 'listen: false\nwhitelistMode: true\nenableUserAccounts: false\nskipContentCheck: true\nbrowserLaunch:\n  enabled: true\n');
            fs.writeFileSync(path.join(user, 'settings.json'), JSON.stringify({
                oai_settings: { chat_completion_source: 'custom', custom_model: 'mock-gateway', custom_url: `http://127.0.0.1:${model.address().port}/v1`, openai_max_tokens: 128 },
            }));
            fs.writeFileSync(path.join(user, 'characters', 'Gateway.json'), JSON.stringify({ name: 'Gateway Character', description: 'Server-owned character description' }));
            fs.writeFileSync(path.join(user, 'agent', 'config.json'), JSON.stringify({
                ...DEFAULT_CONFIG, enabled: true, binding: { mode: 'gateway', character: 'Gateway.json', preset: '' },
            }));
            const port = await availablePort();
            const url = `http://127.0.0.1:${port}`;
            processState = launch(root, port);
            await processState.ready;
            expect(processState.logs).not.toContain('Compiling frontend');
            expect(processState.logs).not.toContain('Launching in a browser');
            expect(await (await fetch(url)).json()).toMatchObject({ service: 'SillyTavern Agent Gateway' });
            expect((await fetch(`${url}/script.js`)).status).toBe(404);
            socket = await connect(url);
            expect((await packet(socket, x => x.type === 'snapshot')).status.running).toBe(true);
            socket.send(JSON.stringify({ id: 'turn-1', method: 'message', params: { text: 'Remember Alice.' } }));
            const first = await packet(socket, x => x.type === 'snapshot' && x.session.messages.some(m => m.content === 'Gateway reply 1'));
            expect(first.session.messages.map(x => x.content)).toEqual(['Remember Alice.', 'Gateway reply 1']);
            expect(JSON.stringify(requests[0].messages)).toContain('Server-owned character description');
            socket.terminate();
            await stop(processState);

            // Change the source while the service is down; no browser needs to refresh a snapshot.
            fs.writeFileSync(path.join(user, 'characters', 'Gateway.json'), JSON.stringify({ name: 'Gateway Character', description: 'Updated description from disk' }));
            processState = launch(root, port);
            await processState.ready;
            socket = await connect(url);
            const restored = await packet(socket, x => x.type === 'snapshot');
            expect(restored.status.running).toBe(true);
            expect(restored.session.messages).toHaveLength(2);
            socket.send(JSON.stringify({ id: 'turn-2', method: 'message', params: { text: 'Continue our work.' } }));
            await packet(socket, x => x.type === 'snapshot' && x.session.messages.some(m => m.content === 'Gateway reply 2'));
            expect(JSON.stringify(requests[1].messages)).toContain('Updated description from disk');
            expect(JSON.stringify(requests[1].messages)).toContain('Remember Alice.');
        } finally {
            socket?.terminate();
            await stop(processState);
            await new Promise(resolve => model.close(resolve));
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
