import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import express from 'express';

import { DEFAULT_USER } from '../constants.js';
import { getConfigValue } from '../util.js';
import { getAllEnabledUsers, getUserDirectories } from '../users.js';
import { readSecret, writeSecret, SECRET_KEYS } from './secrets.js';
import { generateChatCompletion } from './backends/chat-completions.js';
import { AgentStore, validateConfig } from '../agent/store.js';
import { AgentRuntime } from '../agent/runtime.js';
import { QQBot } from '../agent/qq.js';
import { runCompletion } from '../agent/completion.js';
import { GatewaySource } from '../agent/source.js';
import { AgentGateway } from '../agent/gateway.js';

const agents = new Map();
let reconcileTimer;
let closing = false;

function createEntry(profile, directories) {
    const store = new AgentStore(directories.root);
    const entry = { store, profile, directories, control: Promise.resolve(), events: new EventEmitter() };
    entry.source = new GatewaySource(directories, () => JSON.parse(readSecret(directories, SECRET_KEYS.AGENT_MODEL_REQUEST) || '{}'));
    store.on('change', () => entry.events.emit('change'));
    entry.runtime = makeRuntime(entry);
    agents.set(profile.handle, entry);
    return entry;
}

function makeRuntime(entry) {
    const { store, profile, directories } = entry;
    return new AgentRuntime(store, {
        prepareContext: store.config.binding?.mode === 'gateway' ? session => entry.source.prepare(store.config.binding, session, store.config.contextChars) : undefined,
        notify: () => entry.events.emit('change'),
        generate: (messages, signal, preparedRequest) => {
            const value = preparedRequest ? null : readSecret(directories, SECRET_KEYS.AGENT_MODEL_REQUEST);
            if (!preparedRequest && !value) throw new Error('Configure a gateway model connection first.');
            const body = preparedRequest ?? JSON.parse(value);
            body.messages = messages;
            return runCompletion(generateChatCompletion, { profile, directories }, body, signal);
        },
        createQQ: (config, onEvent) => new QQBot(config, {
            onEvent, onStatus: () => entry.events.emit('change'), getSecret: () => readSecret(directories, SECRET_KEYS.AGENT_QQ),
        }),
    });
}

function entryFor(request) {
    const { profile, directories } = request.user;
    return agents.get(profile.handle) ?? createEntry(profile, directories);
}

function publicState(entry) {
    const { binding, ...config } = entry.store.config;
    const queue = entry.store.state.queue.map(({ id, session, source, attempts, error }) => ({ id, session, source, attempts, error }));
    let info = binding ? { mode: binding.mode ?? 'legacy', character: binding.character ?? '', preset: binding.preset ?? '', name: binding.name, model: binding.model, source: binding.source, capturedAt: binding.capturedAt } : null;
    if (binding?.mode === 'gateway') {
        try {
            const resolved = entry.source.resolve(binding);
            info = { ...info, name: resolved.name, model: resolved.request.model, source: resolved.request.chat_completion_source };
        } catch { /* The next turn reports source-file or model errors in the durable queue. */ }
    }
    return {
        config: { ...config, binding: info },
        status: entry.runtime.status(), queue,
        hasQQSecret: Boolean(readSecret(entry.directories, SECRET_KEYS.AGENT_QQ)),
    };
}

function sessionState(entry, key = 'main') {
    const session = entry.store.session(String(key));
    return { key: session.key, summary: session.summary, messages: session.messages.filter(x => !x.silent).slice(-100) };
}

function retryJobs(entry) {
    for (const job of entry.store.state.queue) {
        if (!job.attempts) continue;
        job.attempts = 0;
        job.retryAt = 0;
        delete job.error;
    }
    entry.store.state.lastError = '';
    entry.store.save();
    entry.runtime.tick();
    return publicState(entry);
}

const gateway = new AgentGateway({
    authorize: async entry => getConfigValue('enableUserAccounts', false, 'boolean')
        ? (await getAllEnabledUsers()).some(user => user.handle === entry.profile.handle)
        : entry.profile.handle === DEFAULT_USER.handle,
    snapshot: (entry, key) => ({ ...publicState(entry), session: sessionState(entry, key) }),
    subscribe: (entry, listener) => {
        entry.events.on('change', listener);
        return () => entry.events.off('change', listener);
    },
    dispatch: (entry, method, params) => {
        switch (method) {
            case 'status': return publicState(entry);
            case 'session': return sessionState(entry, params.session);
            case 'message': return entry.runtime.enqueue({ text: params.text, name: entry.profile.name || 'You', session: String(params.session ?? 'main'), source: 'gateway' });
            case 'retry': return retryJobs(entry);
            default: throw new Error('Unknown gateway method.');
        }
    },
});

export function attachGateway(server) {
    gateway.attach(server);
}

// Serialize configuration changes separately from message admission and generation.
function change(entry, action) {
    const result = entry.control.then(action);
    entry.control = result.catch(() => {});
    return result;
}

async function restart(entry, config, beforeSave = () => {}) {
    await entry.runtime.stop();
    try {
        beforeSave();
        entry.store.saveConfig(config);
    } finally {
        entry.runtime = makeRuntime(entry);
        if (!closing) entry.runtime.start();
    }
}

async function reconcile() {
    if (closing) return;
    const users = getConfigValue('enableUserAccounts', false, 'boolean') ? await getAllEnabledUsers() : [DEFAULT_USER];
    const active = new Set(users.map(x => x.handle));
    for (const [handle, entry] of agents) {
        if (!active.has(handle)) {
            await change(entry, async () => {
                await entry.runtime.stop();
                gateway.revoke(entry);
                agents.delete(handle);
            });
        }
    }
    for (const profile of users) {
        if (agents.has(profile.handle)) continue;
        const directories = getUserDirectories(profile.handle);
        if (!fs.existsSync(path.join(directories.root, 'agent', 'config.json'))) continue;
        try {
            const entry = createEntry(profile, directories);
            entry.store.config = validateConfig(entry.store.config);
            entry.runtime.start();
        } catch {
            console.error(`Unable to start ST Agent for account ${profile.handle}; check its agent configuration.`);
        }
    }
}

/** Restore enabled agents when ST starts, without waiting for a browser login. */
export async function init() {
    closing = false;
    clearInterval(reconcileTimer);
    await reconcile();
    reconcileTimer = setInterval(() => reconcile().catch(() => console.error('Unable to reconcile ST Agent accounts.')), 30000);
    reconcileTimer.unref?.();
}

export async function onExit() {
    closing = true;
    clearInterval(reconcileTimer);
    gateway.close();
    await Promise.all([...agents.values()].map(entry => change(entry, () => entry.runtime.stop())));
}

export const router = express.Router();

function route(handler) {
    return async (request, response) => {
        try {
            await handler(request, response, entryFor(request));
        } catch (error) {
            response.status(400).json({ error: error.message });
        }
    };
}

router.get('/status', route(async (req, res, entry) => res.json(publicState(entry))));

router.get('/catalog', route(async (req, res, entry) => res.json(entry.source.catalog())));

router.post('/gateway-ticket', route(async (req, res, entry) => {
    const origin = req.headers.origin || `${req.protocol}://${req.headers.host}`;
    res.json(gateway.issue(entry, origin));
}));

router.get('/session', route(async (req, res, entry) => {
    res.json(sessionState(entry, req.query.key));
}));

router.post('/config', route(async (req, res, entry) => {
    await change(entry, async () => {
        const config = validateConfig({ ...req.body, binding: entry.store.config.binding });
        const secret = req.body.qqSecret;
        if (secret !== undefined && (typeof secret !== 'string' || !secret.trim() || secret.length > 4096)) throw new Error('Invalid QQ AppSecret.');
        if (config.qq.enabled && !secret && !readSecret(entry.directories, SECRET_KEYS.AGENT_QQ)) throw new Error('QQ AppSecret is required.');
        if (config.enabled && (config.heartbeatToQQ || config.tasks.some(x => x.enabled && x.target === 'qq')) && (!config.qq.enabled || !config.qq.ownerOpenId)) {
            throw new Error('QQ delivery needs QQ enabled and an owner OpenID.');
        }
        await restart(entry, config, () => {
            if (secret) writeSecret(entry.directories, SECRET_KEYS.AGENT_QQ, secret.trim());
        });
    });
    res.json(publicState(entry));
}));

router.post('/bind', route(async (req, res, entry) => {
    await change(entry, async () => {
        const { binding, connection } = entry.source.bind(req.body);
        const config = validateConfig({ ...entry.store.config, binding });
        await restart(entry, config, () => writeSecret(entry.directories, SECRET_KEYS.AGENT_MODEL_REQUEST, JSON.stringify(connection)));
    });
    res.json(publicState(entry));
}));

router.post('/message', route(async (req, res, entry) => {
    const result = entry.runtime.enqueue({ text: req.body.text, name: entry.profile.name || 'You', session: String(req.body.session ?? 'main'), source: 'api' });
    res.status(202).json(result);
}));

router.post('/retry', route(async (req, res, entry) => {
    res.json(retryJobs(entry));
}));
