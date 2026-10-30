import fetch from 'node-fetch';
import WebSocket from 'ws';

/** QQ Open Platform transport. Credentials and access tokens never leave the server. */
export class QQBot {
    constructor(config, { getSecret, onEvent, onStatus = () => {}, fetchImpl = fetch, WebSocketImpl = WebSocket }) {
        this.config = config;
        this.getSecret = getSecret;
        this.onEvent = onEvent;
        this.onStatus = onStatus;
        this.fetch = fetchImpl;
        this.WebSocket = WebSocketImpl;
        this.api = config.sandbox ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.sgroup.qq.com';
        this.status = { state: 'disconnected', error: '' };
        this.stopped = true;
        this.backoff = 1000;
        this.frames = Promise.resolve();
    }

    updateStatus(update) {
        Object.assign(this.status, update);
        this.onStatus();
    }

    start() {
        if (!this.stopped) return;
        this.stopped = false;
        this.connect();
    }

    stop() {
        this.stopped = true;
        clearTimeout(this.reconnectTimer);
        clearTimeout(this.refreshTimer);
        clearTimeout(this.readyTimer);
        clearInterval(this.heartbeatTimer);
        this.socket?.terminate();
        this.updateStatus({ state: 'disconnected' });
    }

    async token() {
        if (this.accessToken && Date.now() < this.tokenExpires) return this.accessToken;
        const secret = this.getSecret();
        if (!secret) throw new Error('QQ AppSecret has not been configured.');
        const response = await this.fetch('https://bots.qq.com/app/getAppAccessToken', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ appId: this.config.appId, clientSecret: secret }),
            signal: AbortSignal.timeout(30000),
        });
        if (!response.ok) throw new Error(`QQ token request failed (HTTP ${response.status}).`);
        const data = await response.json();
        if (!data.access_token || !Number.isFinite(Number(data.expires_in))) throw new Error('QQ returned an invalid access token.');
        this.accessToken = data.access_token;
        this.tokenExpires = Date.now() + Math.max(60, Number(data.expires_in) - 60) * 1000;
        return this.accessToken;
    }

    async request(route, body, retry = true) {
        const response = await this.fetch(`${this.api}${route}`, {
            method: body ? 'POST' : 'GET',
            headers: { 'Content-Type': 'application/json', Authorization: `QQBot ${await this.token()}` },
            ...(body ? { body: JSON.stringify(body) } : {}),
            signal: AbortSignal.timeout(30000),
        });
        if (response.status === 401 && retry) {
            this.accessToken = null;
            return this.request(route, body, false);
        }
        if (!response.ok) throw new Error(`QQ API request failed (HTTP ${response.status}).`);
        return response.json();
    }

    async connect() {
        if (this.stopped) return;
        this.updateStatus({ state: 'connecting' });
        try {
            const gateway = await this.request('/gateway');
            if (this.stopped) return;
            const url = new URL(gateway.url);
            if (url.protocol !== 'wss:') throw new Error('QQ gateway must use WSS.');
            const socket = this.socket = new this.WebSocket(url, { handshakeTimeout: 30000, maxPayload: 1024 * 1024 });
            this.readyTimer = setTimeout(() => socket.terminate(), 45000);
            this.readyTimer.unref?.();
            socket.on('message', raw => {
                // Admission is serialized; a failed durable write must not advance the resume sequence.
                this.frames = this.frames.then(async () => {
                    if (this.stopped || this.socket !== socket) return;
                    await this.frame(JSON.parse(raw.toString()), socket);
                }).catch(() => {
                    this.updateStatus({ error: 'QQ event processing failed; reconnecting.' });
                    socket.terminate();
                });
            });
            socket.on('error', () => {
                this.updateStatus({ error: 'QQ WebSocket connection failed.' });
            });
            socket.on('close', (code) => {
                if (this.socket !== socket || this.stopped) return;
                clearInterval(this.heartbeatTimer);
                clearTimeout(this.readyTimer);
                clearTimeout(this.refreshTimer);
                if ([4007, 4009].includes(code)) {
                    this.sessionId = null;
                    this.sequence = null;
                }
                if (code === 4004) this.accessToken = null;
                this.reconnect();
            });
        } catch (error) {
            if (this.stopped) return;
            // Keep credential-bearing network exceptions out of status responses.
            this.updateStatus({ error: /^QQ /.test(error.message) ? error.message : 'QQ connection failed. Check network access and bot settings.' });
            this.reconnect();
        }
    }

    reconnect() {
        if (this.stopped) return;
        clearTimeout(this.reconnectTimer);
        this.updateStatus({ state: 'reconnecting' });
        this.reconnectTimer = setTimeout(() => this.connect(), this.backoff);
        this.reconnectTimer.unref?.();
        this.backoff = Math.min(60000, this.backoff * 2);
    }

    async frame(frame, socket) {
        if (frame.op === 10) {
            const interval = Number(frame.d?.heartbeat_interval);
            if (!Number.isFinite(interval) || interval < 1000) throw new Error('Invalid QQ heartbeat interval.');
            const token = `QQBot ${await this.token()}`;
            if (this.stopped || this.socket !== socket) return;
            if (this.sessionId && this.sequence != null) {
                socket.send(JSON.stringify({ op: 6, d: { token, session_id: this.sessionId, seq: this.sequence } }));
            } else {
                socket.send(JSON.stringify({ op: 2, d: { token, intents: 1 << 25, shard: [0, 1], properties: { os: 'linux', browser: 'SillyTavern', device: 'ST Agent' } } }));
            }
            this.acknowledged = true;
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = setInterval(() => {
                if (!this.acknowledged) return socket.terminate();
                this.acknowledged = false;
                socket.send(JSON.stringify({ op: 1, d: this.sequence ?? null }));
            }, interval);
            this.heartbeatTimer.unref?.();
        } else if (frame.op === 11) {
            this.acknowledged = true;
        } else if (frame.op === 7) {
            socket.terminate();
        } else if (frame.op === 9) {
            this.sessionId = null;
            this.sequence = null;
            socket.terminate();
        } else if (frame.op === 0) {
            if (frame.t === 'READY' || frame.t === 'RESUMED') {
                if (frame.d?.session_id) this.sessionId = frame.d.session_id;
                this.updateStatus({ state: 'connected', error: '' });
                this.backoff = 1000;
                clearTimeout(this.readyTimer);
                clearTimeout(this.refreshTimer);
                this.refreshTimer = setTimeout(() => socket.terminate(), Math.max(1000, this.tokenExpires - Date.now()));
                this.refreshTimer.unref?.();
            } else if (['C2C_MESSAGE_CREATE', 'GROUP_AT_MESSAGE_CREATE'].includes(frame.t)) {
                const data = frame.d;
                const sender = data.author?.user_openid ?? data.author?.member_openid;
                if (data.id && sender && /^[\w-]{1,128}$/.test(sender)) {
                    await this.onEvent({
                        id: data.id, sender, groupId: data.group_openid,
                        text: String(data.content ?? '').replace(/<@!?\d+>/g, '').trim(),
                    });
                }
            }
            if (Number.isInteger(frame.s)) this.sequence = frame.s;
        }
    }

    async sendText(target, text, offset = 0, onChunk = () => {}) {
        if (this.stopped) throw new Error('QQ connection has stopped.');
        if (!['c2c', 'group'].includes(target.kind) || !/^[\w-]{1,128}$/.test(target.id)) throw new Error('Invalid QQ destination.');
        const route = target.kind === 'group' ? `/v2/groups/${encodeURIComponent(target.id)}/messages` : `/v2/users/${encodeURIComponent(target.id)}/messages`;
        const points = Array.from(text);
        // Stay below QQ's per-message and passive-reply limits. The full reply remains in ST.
        const chunks = [];
        for (let i = 0; i < Math.min(points.length, 6000); i += 1500) chunks.push(points.slice(i, i + 1500).join(''));
        if (points.length > 6000) chunks[chunks.length - 1] += '\n…完整回复请在 SillyTavern 查看。';
        for (let i = offset; i < chunks.length; i++) {
            if (this.stopped) throw new Error('QQ connection has stopped.');
            await this.request(route, {
                content: chunks[i], msg_type: 0,
                ...(target.messageId ? { msg_id: target.messageId, msg_seq: i + 1 } : {}),
            });
            onChunk(i + 1);
        }
    }
}
