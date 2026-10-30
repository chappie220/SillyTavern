import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { sync as writeFileAtomicSync } from 'write-file-atomic';

export const DEFAULT_CONFIG = {
    enabled: false,
    binding: null,
    memory: '',
    contextChars: 24000,
    heartbeatMinutes: 0,
    heartbeatPrompt: 'Review our conversation and pending plans. If there is something useful to report, reply briefly. Otherwise reply exactly HEARTBEAT_OK.',
    heartbeatToQQ: false,
    qq: { enabled: false, appId: '', ownerOpenId: '', sandbox: false, allowedGroups: [] },
    tasks: [],
};

function integer(value, min, max, name) {
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(`${name} must be an integer between ${min} and ${max}.`);
    }
    return value;
}

/** Validate the complete configuration before changing a running agent. */
export function validateConfig(input) {
    const config = structuredClone(DEFAULT_CONFIG);
    for (const key of ['enabled', 'heartbeatToQQ']) {
        if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error(`Invalid ${key}.`);
        config[key] = input[key] ?? config[key];
    }
    config.binding = input.binding ?? null;
    config.memory = String(input.memory ?? '').slice(0, 16000);
    config.contextChars = integer(input.contextChars ?? config.contextChars, 4000, 500000, 'Context budget');
    config.heartbeatMinutes = integer(input.heartbeatMinutes ?? 0, 0, 10080, 'Heartbeat interval');
    config.heartbeatPrompt = String(input.heartbeatPrompt ?? config.heartbeatPrompt).trim().slice(0, 8000);
    const qq = input.qq ?? {};
    for (const key of ['enabled', 'sandbox']) {
        if (qq[key] !== undefined && typeof qq[key] !== 'boolean') throw new Error(`Invalid QQ ${key}.`);
        config.qq[key] = qq[key] ?? false;
    }
    config.qq.appId = String(qq.appId ?? '').trim();
    config.qq.ownerOpenId = String(qq.ownerOpenId ?? '').trim();
    if (config.qq.appId && !/^\d{1,32}$/.test(config.qq.appId)) throw new Error('Invalid QQ AppID.');
    if (!Array.isArray(qq.allowedGroups ?? []) || (qq.allowedGroups ?? []).length > 50) throw new Error('Invalid QQ groups.');
    config.qq.allowedGroups = [...new Set((qq.allowedGroups ?? []).map(x => String(x).trim()).filter(Boolean))];
    if (config.qq.allowedGroups.some(x => !/^[\w-]{1,128}$/.test(x))) throw new Error('Invalid group OpenID.');
    if (config.qq.ownerOpenId && !/^[\w-]{1,128}$/.test(config.qq.ownerOpenId)) throw new Error('Invalid owner OpenID.');
    if (config.qq.enabled && !config.qq.appId) throw new Error('QQ AppID is required.');
    if (config.enabled && !config.binding) throw new Error('Bind a character and model first.');
    if (!Array.isArray(input.tasks ?? []) || (input.tasks ?? []).length > 50) throw new Error('At most 50 tasks are supported.');
    config.tasks = (input.tasks ?? []).map(task => {
        if (!task || typeof task.id !== 'string' || !/^[\w-]{1,80}$/.test(task.id)) throw new Error('Invalid task ID.');
        const prompt = String(task.prompt ?? '').trim();
        if (!prompt || prompt.length > 8000) throw new Error('Task prompt is required (up to 8000 characters).');
        const at = Date.parse(task.at);
        if (!Number.isFinite(at)) throw new Error('A task needs a valid next run time.');
        const intervalMinutes = integer(task.intervalMinutes ?? 0, 0, 525600, 'Task interval');
        if (typeof task.enabled !== 'boolean' || !['main', 'qq'].includes(task.target)) throw new Error('Invalid task options.');
        return { id: task.id, prompt, at: new Date(at).toISOString(), intervalMinutes, enabled: task.enabled, target: task.target };
    });
    if (new Set(config.tasks.map(x => x.id)).size !== config.tasks.length) throw new Error('Task IDs must be unique.');
    return config;
}

/** All files belong to one ST account; no browser or QQ identifier becomes a path. */
export class AgentStore extends EventEmitter {
    constructor(userRoot) {
        super();
        this.root = path.join(userRoot, 'agent');
        this.config = this.read('config.json', DEFAULT_CONFIG);
        this.state = this.read('state.json', { sessions: {}, queue: [], completed: [], taskRuns: {}, lastHeartbeat: Date.now(), lastError: '' });
    }

    read(file, fallback) {
        const target = path.join(this.root, file);
        return fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : structuredClone(fallback);
    }

    write(file, value) {
        fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
        writeFileAtomicSync(path.join(this.root, file), JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
    }

    saveConfig(config) {
        this.write('config.json', config);
        this.config = config;
        this.emit('change');
    }

    save() {
        this.write('state.json', this.state);
        this.emit('change');
    }

    session(key = 'main') {
        if (key !== 'main' && !/^qq:group:[\w-]{1,128}$/.test(key)) throw new Error('Invalid session.');
        return this.state.sessions[key] ??= { key, messages: [], summary: '', summaryUntil: 0 };
    }
}
