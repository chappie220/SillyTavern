import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { sync as writeFileAtomicSync } from 'write-file-atomic';
import sanitize from 'sanitize-filename';

const chats = new Map();

/** Only explicitly bound, account-owned character chats participate in the agent. */
export function getAgentChat(file) {
    return chats.get(path.resolve(file));
}

export function validateChatTarget(target, character) {
    if (!target || target.avatar !== character || !/\.png$/i.test(character)) throw new Error('Select a character chat for main.');
    for (const value of [target.avatar, target.file]) {
        if (typeof value !== 'string' || !value.trim() || sanitize(value) !== value) throw new Error('Invalid main chat filename.');
    }
    return { avatar: target.avatar, file: target.file };
}

/** A normal ST JSONL chat is the source of truth for a bound main session. */
export class AgentChat {
    constructor(store, directories) {
        this.store = store;
        this.directory = directories.chats ?? path.join(directories.root, 'chats');
    }

    validate(binding) {
        if (!binding?.chat) return;
        const target = validateChatTarget(binding.chat, binding.character);
        const file = path.resolve(this.directory, target.avatar.replace('.png', ''), `${target.file}.jsonl`);
        const parent = fs.realpathSync(this.directory);
        const real = fs.realpathSync(file);
        if (!real.startsWith(parent + path.sep)) throw new Error('Main chat is outside this account.');
        return { target, file, data: this.read(file) };
    }

    bind(binding, { migrate = false } = {}) {
        const checked = this.validate(binding);
        this.close();
        this.file = undefined;
        if (!checked) return;
        const { target, file, data } = checked;
        this.target = target;
        this.file = file;
        const previous = migrate ? this.store.state.sessions.main?.messages.slice() ?? [] : [];
        this.import(data);
        // Preserve the old standalone history when migrating, without duplicating native messages.
        const session = this.store.state.sessions.main;
        const ids = new Set(session.messages.map(message => message.id));
        session.messages.push(...previous.filter(message => !message.native && !ids.has(message.id)));
        chats.set(this.file, this);
        this.flush();
    }

    read(file = this.file) {
        const data = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
        if (!data[0]?.chat_metadata || data.slice(1).some(message => typeof message.mes !== 'string')) throw new Error('Invalid main chat file.');
        return data;
    }

    import(data) {
        this.header = structuredClone(data[0]);
        this.serialized = JSON.stringify(data.slice(1));
        const messages = data.slice(1).map((native, index) => ({
            id: native.extra?.agent?.id ?? createHash('sha256').update(`${index}:${JSON.stringify(native)}`).digest('hex'),
            role: native.is_system ? 'system' : native.is_user ? 'user' : 'assistant',
            content: native.mes, name: native.name, at: native.send_date,
            source: native.extra?.agent?.source ?? 'chat', native: structuredClone(native),
        }));
        const session = this.store.state.sessions.main ??= { key: 'main', messages: [], summary: '', summaryUntil: 0 };
        const changed = JSON.stringify(session.messages.map(({ role, content }) => ({ role, content }))) !== JSON.stringify(messages.map(({ role, content }) => ({ role, content })));
        session.messages.splice(0, session.messages.length, ...messages);
        if (changed) { session.summary = ''; session.summaryUntil = 0; }
    }

    document() {
        if (!this.file) return undefined;
        return { ...this.target, header: structuredClone(this.header), messages: JSON.parse(this.serialized) };
    }

    flush() {
        if (!this.file) return;
        const messages = this.store.state.sessions.main.messages.filter(message => !message.silent).map(message => {
            const native = structuredClone(message.native ?? {});
            return {
                ...native, name: native.name ?? (message.role === 'assistant' ? this.store.config.binding?.name || 'Agent' : message.name),
                is_user: message.role === 'user', is_system: message.role === 'system',
                send_date: message.at, mes: message.content,
                extra: { ...native.extra, agent: { ...native.extra?.agent, id: message.id, source: message.source } },
            };
        });
        const serialized = JSON.stringify(messages);
        if (serialized === this.serialized) return;
        this.header.chat_metadata.agent_revision = randomUUID();
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        writeFileAtomicSync(this.file, [this.header, ...messages].map(row => JSON.stringify(row)).join('\n'), 'utf8');
        this.serialized = serialized;
    }

    /** Called after the ordinary chat endpoint's integrity check, without yielding. */
    save(data) {
        if (data[0]?.chat_metadata?.agent_revision !== this.header.chat_metadata.agent_revision) {
            const error = new Error('New background messages arrived. Reload the chat before retrying this edit.');
            error.code = 'agent_conflict';
            throw error;
        }
        if (!Array.isArray(data) || !data[0]?.chat_metadata || data.slice(1).some(message => typeof message.mes !== 'string')) throw new Error('Invalid main chat data.');
        if (JSON.stringify(data) === JSON.stringify([this.header, ...JSON.parse(this.serialized)])) return this.document();
        this.import(data);
        // Include stable IDs in ordinary messages too, for edits, swipes and subsequent reconnects.
        this.serialized = '';
        this.store.save();
        return this.document();
    }

    close() {
        if (this.file && chats.get(this.file) === this) chats.delete(this.file);
    }
}
