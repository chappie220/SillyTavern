import { describe, expect, jest, test } from '@jest/globals';
import { runCompletion } from '../src/agent/completion.js';

describe('ST background completion adapter', () => {
    test('uses the existing handler with a private socket, ST identity and nonstreaming parameters', async () => {
        const user = { profile: { handle: 'alice' }, directories: { root: '/private/alice' } };
        const handler = jest.fn(async (req, res) => {
            expect(req.user).toBe(user);
            expect(req.body.stream).toBe(false);
            expect(req.body.n).toBe(1);
            expect(req.body.tools).toBeUndefined();
            res.send({ choices: [{ message: { content: 'Hello Alice' } }] });
        });
        expect(await runCompletion(handler, user, { stream: true, tools: [{}] })).toBe('Hello Alice');
    });

    for (const [name, data] of [
        ['Claude', { content: [{ type: 'thinking', text: 'private reasoning' }, { type: 'text', text: 'Claude reply' }] }],
        ['Cohere', { message: { content: [{ text: 'Cohere reply' }] } }],
    ]) {
        test(`extracts ${name} text without exposing reasoning`, async () => {
            const text = await runCompletion(async (req, res) => res.send(data), {}, {});
            expect(text).toMatch(/reply/);
            expect(text).not.toContain('private reasoning');
        });
    }

    test('aborting cancels the provider socket and ignores a late response', async () => {
        const controller = new AbortController();
        const closed = jest.fn();
        let reply;
        const result = runCompletion(async (req, res) => {
            req.socket.on('close', closed);
            reply = res;
        }, {}, {}, controller.signal);
        await Promise.resolve();
        controller.abort();
        await expect(result).rejects.toThrow('interrupted');
        expect(closed).toHaveBeenCalledTimes(1);
        reply.send({ choices: [{ message: { content: 'Late' } }] });
    });

    test('timeouts reject and cancel a stalled provider', async () => {
        const closed = jest.fn();
        await expect(runCompletion(async req => req.socket.on('close', closed), {}, {}, undefined, 10)).rejects.toThrow('timed out');
        expect(closed).toHaveBeenCalledTimes(1);
    });

    test('provider errors are not mistaken for assistant replies', async () => {
        await expect(runCompletion(async (req, res) => res.status(400).send({ error: { message: 'secret-bearing upstream details' } }), {}, {})).rejects.toThrow('Check the ST connection');
    });
});
