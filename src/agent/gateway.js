import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';

export const GATEWAY_PATH = '/api/agent/gateway';

/** Authenticated, account-scoped WebSocket gateway shared by UI and headless clients. */
export class AgentGateway {
    constructor({ authorize, snapshot, dispatch, subscribe, now = Date.now }) {
        this.authorize = authorize;
        this.snapshot = snapshot;
        this.dispatch = dispatch;
        this.subscribe = subscribe;
        this.now = now;
        this.tickets = new Map();
        this.servers = new Map();
        this.clients = new Set();
    }

    issue(subject, origin) {
        for (const [id, ticket] of this.tickets) if (ticket.expires <= this.now()) this.tickets.delete(id);
        if (this.tickets.size >= 1000) throw new Error('Too many pending gateway connections.');
        const token = randomBytes(32).toString('base64url');
        this.tickets.set(token, { subject, origin, expires: this.now() + 30000 });
        return { ticket: token, path: GATEWAY_PATH, expiresIn: 30 };
    }

    attach(server) {
        if (this.servers.has(server)) return;
        const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: false });
        const upgrade = async (request, socket, head) => {
            let url;
            try { url = new URL(request.url, 'http://gateway.local'); } catch { return socket.destroy(); }
            if (url.pathname !== GATEWAY_PATH) return;
            socket.on('error', () => {});
            const token = url.searchParams.get('ticket');
            const ticket = this.tickets.get(token);
            this.tickets.delete(token);
            const reject = () => {
                if (socket.destroyed) return;
                socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
            };
            if (!ticket || ticket.expires <= this.now() || request.headers.origin && request.headers.origin !== ticket.origin) return reject();
            try {
                if (!await this.authorize(ticket.subject) || socket.destroyed) return reject();
                if ([...this.clients].filter(x => x.subject === ticket.subject).length >= 8) return reject();
                wss.handleUpgrade(request, socket, head, ws => this.connect(ws, ticket.subject));
            } catch { reject(); }
        };
        server.on('upgrade', upgrade);
        this.servers.set(server, { wss, upgrade });
        server.once('close', () => {
            if (!this.servers.has(server)) return;
            server.removeListener('upgrade', upgrade);
            this.servers.delete(server);
            wss.close();
        });
    }

    connect(ws, subject) {
        const client = { ws, subject, session: 'main', alive: true, pending: false };
        this.clients.add(client);
        const send = data => {
            if (ws.readyState !== WebSocket.OPEN) return;
            if (ws.bufferedAmount > 1024 * 1024) return ws.close(1013, 'Client is too slow');
            try { ws.send(JSON.stringify(data)); } catch { ws.terminate(); }
        };
        const push = () => {
            if (client.pending) return;
            client.pending = true;
            queueMicrotask(() => {
                client.pending = false;
                if (ws.readyState !== WebSocket.OPEN) return;
                try { send({ type: 'snapshot', ...this.snapshot(subject, client.session) }); } catch { send({ type: 'error', error: 'Unable to read gateway state.' }); }
            });
        };
        const unsubscribe = this.subscribe(subject, push);
        const heartbeat = setInterval(() => {
            if (!client.alive) return ws.terminate();
            client.alive = false;
            ws.ping();
        }, 30000);
        heartbeat.unref?.();
        ws.on('pong', () => { client.alive = true; });
        ws.on('error', () => {});
        ws.once('close', () => {
            clearInterval(heartbeat);
            unsubscribe();
            this.clients.delete(client);
        });
        let chain = Promise.resolve();
        ws.on('message', (raw, binary) => {
            chain = chain.then(async () => {
                let id;
                try {
                    const message = JSON.parse(raw.toString());
                    id = message.id;
                    if (binary || typeof id !== 'string' || id.length > 100 || typeof message.method !== 'string') throw new Error('Invalid gateway command.');
                    if (!await this.authorize(subject)) return ws.close(1008, 'Account access revoked');
                    const params = message.params ?? {};
                    if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Invalid gateway parameters.');
                    let result;
                    if (message.method === 'subscribe') {
                        const key = String(params.session ?? 'main');
                        this.snapshot(subject, key); // Validate before changing the subscription.
                        client.session = key;
                        result = { session: key };
                        push();
                    } else {
                        result = await this.dispatch(subject, message.method, params);
                    }
                    send({ type: 'response', id, ok: true, result });
                } catch (error) {
                    send({ type: 'response', id, ok: false, error: error.message });
                }
            }).catch(() => ws.close(1011, 'Gateway command failed'));
        });
        push();
    }

    revoke(subject) {
        for (const client of this.clients) if (client.subject === subject) client.ws.close(1008, 'Account access revoked');
        for (const [id, ticket] of this.tickets) if (ticket.subject === subject) this.tickets.delete(id);
    }

    close() {
        this.tickets.clear();
        for (const client of this.clients) client.ws.terminate();
        for (const [server, { wss, upgrade }] of this.servers) {
            server.removeListener('upgrade', upgrade);
            wss.close();
        }
        this.servers.clear();
    }
}
