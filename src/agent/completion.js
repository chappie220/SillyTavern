import { EventEmitter } from 'node:events';

/** Invoke ST's existing provider handler in-process, with no loopback HTTP or cookies. */
export function runCompletion(handler, user, body, signal, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
        const socket = new EventEmitter();
        let finished = false;
        let timer;
        const finish = (error, value) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            socket.removeAllListeners();
            error ? reject(error) : resolve(value);
        };
        const abort = () => {
            socket.emit('close');
            finish(new Error('Agent generation was interrupted.'));
        };
        if (signal?.aborted) return abort();
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => {
            socket.emit('close');
            finish(new Error('Agent model request timed out.'));
        }, timeoutMs);
        timer.unref?.();
        const response = {
            statusCode: 200,
            headersSent: false,
            writableEnded: false,
            status(code) { this.statusCode = code; return this; },
            setHeader() { return this; },
            sendStatus(code) { this.statusCode = code; return this.send({ error: true }); },
            json(data) { return this.send(data); },
            send(data) {
                this.headersSent = this.writableEnded = true;
                const text = data?.content?.filter(p => p.type === 'text')?.map(p => p.text)?.join('\n\n')
                    ?? data?.choices?.[0]?.message?.content ?? data?.choices?.[0]?.text
                    ?? data?.text ?? data?.message?.content?.[0]?.text;
                if (this.statusCode >= 400 || data?.error) {
                    finish(new Error('Agent model request failed. Check the ST connection and server log.'));
                } else if (typeof text !== 'string' || !text.trim()) {
                    finish(new Error('The model returned no text. Use a text chat-completion model.'));
                } else {
                    finish(null, text.trim());
                }
                return this;
            },
            end() { finish(new Error('The model response ended without text.')); },
        };
        const request = { body: { ...structuredClone(body), stream: false, n: 1 }, user, socket, headers: {}, query: {} };
        delete request.body.tools;
        delete request.body.tool_choice;
        Promise.resolve().then(() => handler(request, response)).catch(() => {
            finish(new Error('Agent model request failed. Check the ST connection and server log.'));
        });
    });
}
