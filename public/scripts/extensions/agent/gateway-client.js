/** Thin view transport. All generation, routing and source loading belongs to the server. */
export class AgentGatewayClient {
    constructor({ getTicket, WebSocketImpl = WebSocket, baseUrl = location.href }) {
        this.getTicket = getTicket;
        this.WebSocket = WebSocketImpl;
        this.baseUrl = baseUrl;
        this.pending = new Map();
        this.listeners = new Set();
        this.connectionListeners = new Set();
        this.session = 'main';
        this.sequence = 0;
        this.backoff = 1000;
        this.closed = false;
    }

    onSnapshot(listener) {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    onConnection(listener) {
        this.connectionListeners.add(listener);
        return () => this.connectionListeners.delete(listener);
    }

    connect() {
        if (this.socket?.readyState === 1) return Promise.resolve();
        if (this.connecting) return this.connecting;
        this.closed = false;
        this.connecting = (async () => {
            const credentials = await this.getTicket();
            if (this.closed) throw new Error('网关客户端已关闭。');
            const url = new URL(credentials.path, this.baseUrl);
            url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
            url.searchParams.set('ticket', credentials.ticket);
            await new Promise((resolve, reject) => {
                const socket = this.socket = new this.WebSocket(url);
                const timer = setTimeout(() => { reject(new Error('网关连接超时。')); socket.close(); }, 10000);
                socket.onmessage = event => this.receive(event);
                socket.onopen = () => {
                    clearTimeout(timer);
                    if (this.closed) { socket.close(); return; }
                    this.backoff = 1000;
                    this.connectionListeners.forEach(listener => listener(true));
                    resolve();
                    if (this.session !== 'main') this.send('subscribe', { session: this.session }).catch(() => {});
                };
                socket.onerror = () => { clearTimeout(timer); reject(new Error('无法连接 ST 网关。')); };
                socket.onclose = () => {
                    clearTimeout(timer);
                    reject(new Error('网关连接已断开。'));
                    for (const request of this.pending.values()) {
                        clearTimeout(request.timer);
                        request.reject(new Error('网关连接已断开。消息是否已接收请重连后查看历史。'));
                    }
                    this.pending.clear();
                    this.connectionListeners.forEach(listener => listener(false));
                    this.reconnect();
                };
            });
        })().catch(error => {
            this.reconnect();
            throw error;
        }).finally(() => { this.connecting = null; });
        return this.connecting;
    }

    reconnect() {
        clearTimeout(this.reconnectTimer);
        if (this.closed) return;
        this.reconnectTimer = setTimeout(() => this.connect().catch(() => {}), this.backoff);
        this.backoff = Math.min(15000, this.backoff * 2);
    }

    receive(event) {
        let data;
        try { data = JSON.parse(event.data); } catch { return; }
        if (data.type === 'snapshot') {
            for (const listener of this.listeners) {
                try { listener(data); } catch (error) { console.error('Agent view update failed:', error); }
            }
        } else if (data.type === 'response') {
            const request = this.pending.get(data.id);
            if (!request) return;
            this.pending.delete(data.id);
            clearTimeout(request.timer);
            data.ok ? request.resolve(data.result) : request.reject(new Error(data.error));
        }
    }

    send(method, params) {
        return new Promise((resolve, reject) => {
            const id = String(++this.sequence);
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('网关请求超时。')); }, 10000);
            this.pending.set(id, { resolve, reject, timer });
            try { this.socket.send(JSON.stringify({ id, method, params })); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
        });
    }

    async request(method, params = {}) {
        await this.connect();
        const result = await this.send(method, params);
        if (method === 'subscribe') this.session = result.session;
        return result;
    }

    close() {
        this.closed = true;
        clearTimeout(this.reconnectTimer);
        this.socket?.close();
    }
}
