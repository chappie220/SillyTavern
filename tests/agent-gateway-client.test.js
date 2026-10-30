import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { AgentGatewayClient } from '../public/scripts/extensions/agent/gateway-client.js';

let sockets;
let clients;
class FakeSocket {
    constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.sent = [];
        sockets.push(this);
    }
    open() { this.readyState = 1; this.onopen(); }
    send(value) { this.sent.push(JSON.parse(value)); }
    message(value) { this.onmessage({ data: JSON.stringify(value) }); }
    close() { this.readyState = 3; this.onclose?.(); }
}
beforeEach(() => { sockets = []; clients = []; });
afterEach(() => clients.forEach(x => x.close()));

async function connect() {
    const getTicket = jest.fn(async () => ({ ticket: 'one-time-ticket', path: '/api/agent/gateway' }));
    const client = new AgentGatewayClient({ getTicket, WebSocketImpl: FakeSocket, baseUrl: 'https://st.test/' });
    clients.push(client);
    const connecting = client.connect();
    await Promise.resolve();
    const socket = sockets.at(-1);
    socket.open();
    await connecting;
    return { client, socket, getTicket };
}

describe('thin gateway view client', () => {
    test('uses one authenticated WebSocket and renders unsolicited pushes without requesting updates', async () => {
        const { client, socket, getTicket } = await connect();
        const listener = jest.fn();
        client.onSnapshot(listener);
        socket.message({ type: 'snapshot', session: { key: 'main', messages: ['New assistant reply'] } });
        expect(listener).toHaveBeenCalledTimes(1);
        expect(socket.sent).toHaveLength(0);
        expect(getTicket).toHaveBeenCalledTimes(1);
        expect(socket.url.protocol).toBe('wss:');
    });

    test('correlates commands and retains errors rather than displaying them as assistant replies', async () => {
        const { client, socket } = await connect();
        const result = client.request('message', { text: 'Hello' });
        await Promise.resolve();
        const command = socket.sent[0];
        expect(command.method).toBe('message');
        socket.message({ type: 'response', id: command.id, ok: true, result: { id: 'accepted-job' } });
        expect(await result).toEqual({ id: 'accepted-job' });
        const failed = client.request('message', { text: '' });
        await Promise.resolve();
        socket.message({ type: 'response', id: socket.sent.at(-1).id, ok: false, error: 'Empty message' });
        await expect(failed).rejects.toThrow('Empty message');
    });

    test('does not automatically resend a message whose acknowledgment was lost', async () => {
        const { client, socket } = await connect();
        const result = client.request('message', { text: 'Do this once' });
        await Promise.resolve();
        socket.close();
        await expect(result).rejects.toThrow('重连后查看历史');
        expect(client.pending.size).toBe(0);
        expect(socket.sent).toHaveLength(1);
    });
});
