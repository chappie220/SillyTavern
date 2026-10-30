import fs from 'node:fs';
import path from 'node:path';
import { read as readCard } from '../character-card-parser.js';
import { CHAT_COMPLETION_SOURCES } from '../constants.js';
import { validateChatTarget } from './chat.js';

const DEFAULT_ORDER = ['main', 'worldInfoBefore', 'personaDescription', 'charDescription', 'charPersonality', 'scenario', 'nsfw', 'worldInfoAfter', 'dialogueExamples', 'chatHistory', 'jailbreak'];
const MODEL_FIELDS = { makersuite: 'google_model', vertexai: 'vertexai_model', azure_openai: 'azure_openai_model' };
const PARAMETER_NAMES = {
    temperature: 'temp_openai', frequency_penalty: 'freq_pen_openai', presence_penalty: 'pres_pen_openai',
    top_p: 'top_p_openai', top_k: 'top_k_openai', min_p: 'min_p_openai', top_a: 'top_a_openai', repetition_penalty: 'repetition_penalty_openai',
};

function plainName(name) {
    if (typeof name !== 'string' || !name || name.length > 255 || name !== path.basename(name) || /[\\/\x00]/.test(name) || name === '.' || name === '..') {
        throw new Error('Invalid gateway resource name.');
    }
    return name;
}

/** Build ST provider parameters on the server; browser UI state is never an input. */
export function buildGatewayRequest(settings, overrides = {}) {
    const source = overrides.chat_completion_source ?? settings.chat_completion_source;
    const model = overrides.model ?? settings[MODEL_FIELDS[source] ?? `${source}_model`];
    if (!Object.values(CHAT_COMPLETION_SOURCES).includes(source) || typeof model !== 'string' || !model.trim() || model === 'OR_Website') {
        throw new Error('Configure a concrete chat-completion source and model for the gateway.');
    }
    const body = {
        type: 'quiet', model, chat_completion_source: source, stream: false, n: 1,
        max_tokens: settings.openai_max_tokens ?? 512,
        include_reasoning: Boolean(settings.show_thoughts),
    };
    for (const [target, native] of Object.entries(PARAMETER_NAMES)) {
        const value = settings[native] ?? settings[target];
        if (value !== undefined && Number.isFinite(Number(value))) body[target] = Number(value);
    }
    for (const key of [
        'custom_url', 'custom_include_body', 'custom_exclude_body', 'custom_include_headers', 'custom_prompt_post_processing',
        'reverse_proxy', 'proxy_password', 'use_sysprompt', 'vertexai_auth_mode', 'vertexai_region', 'vertexai_express_project_id',
        'azure_base_url', 'azure_deployment_name', 'azure_api_version', 'workers_ai_account_id', 'reasoning_effort', 'verbosity',
        'enable_web_search', 'seed', 'secret_id', 'siliconflow_endpoint', 'minimax_endpoint', 'zai_endpoint', 'pollinations_endpoint',
    ]) {
        if (settings[key] !== undefined) body[key] = settings[key];
    }
    if (body.reasoning_effort === 'auto') delete body.reasoning_effort;
    if (body.verbosity === 'auto') delete body.verbosity;
    if (source === 'openrouter') {
        body.use_fallback = Boolean(settings.openrouter_use_fallback);
        body.provider = settings.openrouter_providers;
        body.allow_fallbacks = settings.openrouter_allow_fallbacks;
    }
    Object.assign(body, overrides);
    if (!Number.isInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 1000000) throw new Error('Invalid gateway output token limit.');
    if (['openai', 'azure_openai', 'openrouter'].includes(source) && /(?:^|\/)o[134]|gpt-5/.test(model)) {
        body.max_completion_tokens = body.max_tokens;
        delete body.max_tokens;
        if (!/gpt-5\.[1234]/.test(model)) {
            for (const key of ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty']) delete body[key];
        }
    }
    if (source === 'minimax' && body.temperature !== undefined) body.temperature = Math.min(1, Math.max(Number.EPSILON, body.temperature));
    if (source === 'deepseek' && body.top_p === 0) body.top_p = Number.EPSILON;
    if (['groq', 'workers_ai'].includes(source)) delete body.n;
    for (const key of ['messages', 'tools', 'tool_choice', 'json_schema']) delete body[key];
    body.stream = false;
    return body;
}

/** Cached account-scoped source files; cache invalidation follows on-disk changes. */
export class GatewaySource {
    constructor(directories, getConnection = () => ({})) {
        this.directories = directories;
        this.getConnection = getConnection;
        this.cache = new Map();
    }

    read(file, parser = JSON.parse) {
        const stat = fs.statSync(file);
        const stamp = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        if (this.cache.get(file)?.stamp !== stamp) {
            const value = parser(fs.readFileSync(file));
            this.cache.set(file, { stamp, value });
        }
        return this.cache.get(file).value;
    }

    directory(key, fallback) {
        return this.directories[key] ?? path.join(this.directories.root, fallback);
    }

    resource(directory, name) {
        const file = path.join(directory, plainName(name));
        const parent = fs.realpathSync(directory);
        const real = fs.realpathSync(file);
        if (!real.startsWith(parent + path.sep)) throw new Error('Gateway resource is outside the account directory.');
        return real;
    }

    settings() {
        const file = path.join(this.directories.root, 'settings.json');
        return fs.existsSync(file) ? this.read(file) : {};
    }

    catalog() {
        const list = (directory, extensions) => fs.existsSync(directory) ? fs.readdirSync(directory).filter(name => extensions.includes(path.extname(name).toLowerCase())).sort() : [];
        return {
            characters: list(this.directory('characters', 'characters'), ['.png', '.json']),
            presets: list(this.directory('openAI_Settings', 'OpenAI Settings'), ['.json']).map(name => name.slice(0, -5)),
        };
    }

    resolve(binding, overrides = this.getConnection()) {
        const saved = this.settings();
        let settings = { ...(saved.oai_settings ?? {}) };
        if (binding.preset) {
            const preset = this.read(this.resource(this.directory('openAI_Settings', 'OpenAI Settings'), `${binding.preset}.json`));
            settings = { ...settings, ...preset };
            for (const [key, native] of Object.entries(PARAMETER_NAMES)) if (preset[key] !== undefined) settings[native] = preset[key];
        }
        let card = {};
        if (binding.character) {
            const file = this.resource(this.directory('characters', 'characters'), binding.character);
            const parsed = path.extname(file).toLowerCase() === '.png' ? this.read(file, buffer => JSON.parse(readCard(buffer))) : this.read(file);
            card = parsed.data ?? parsed;
        }
        const request = buildGatewayRequest(settings, overrides);
        const profile = saved.extension_settings?.connectionManager;
        const selected = profile?.profiles?.find(x => x.id === profile.selectedProfile);
        if (selected?.['secret-id'] && !request.secret_id) request.secret_id = selected['secret-id'];
        return { saved, settings, card, request, name: String(card.name || 'ST Agent'), user: String(saved.name1 || saved.username || 'You') };
    }

    bind(input) {
        if (input.request || input.systemMessages) throw new Error('Gateway binding takes file references, not browser prompt snapshots.');
        const binding = {
            mode: 'gateway', character: input.character ? plainName(input.character) : '', preset: input.preset ? plainName(input.preset) : '',
            systemPrompt: String(input.systemPrompt ?? '').slice(0, 16000), capturedAt: new Date().toISOString(),
        };
        if (input.chat) {
            binding.chat = validateChatTarget(input.chat, binding.character);
            this.resource(path.join(this.directory('chats', 'chats'), binding.character.replace('.png', '')), `${binding.chat.file}.jsonl`);
        }
        const connection = input.connection ?? {};
        if (!connection || typeof connection !== 'object' || Array.isArray(connection) || JSON.stringify(connection).length > 100000) throw new Error('Invalid gateway connection configuration.');
        const resolved = this.resolve(binding, connection);
        return { binding: { ...binding, name: resolved.name, source: resolved.request.chat_completion_source, model: resolved.request.model }, connection };
    }

    /** Assemble prompt order, common macros and keyword lore on every gateway turn. */
    prepare(binding, session, contextChars) {
        const resolved = this.resolve(binding);
        const { saved, settings, card, request, name, user } = resolved;
        const values = {
            char: name, charIfNotGroup: name, user, description: card.description ?? '', personality: card.personality ?? '',
            scenario: card.scenario ?? '', persona: saved.power_user?.persona_description ?? '',
            mesExamples: card.mes_example ?? '', original: '',
            lastMessage: session.messages.at(-1)?.content ?? '', lastUserMessage: session.messages.findLast(x => x.role === 'user')?.content ?? '',
            date: new Date().toLocaleDateString('en-CA'), time: new Date().toISOString().slice(11, 19),
        };
        const expand = text => {
            let result = String(text ?? '');
            for (let pass = 0; pass < 3; pass++) {
                const next = result.replace(/{{\s*([\w]+)\s*}}/g, (match, key) => values[key] ?? match);
                if (next === result) break;
                result = next;
            }
            return result;
        };
        const lore = this.lore(binding, resolved, session, contextChars, expand);
        const personality = expand(settings.personality_format || '{{personality}}');
        const scenario = expand(settings.scenario_format || '{{scenario}}');
        const fields = {
            charDescription: expand(card.description), charPersonality: personality, scenario,
            personaDescription: expand(saved.power_user?.persona_description),
            worldInfoBefore: lore.before.join('\n\n'), worldInfoAfter: lore.after.join('\n\n'),
            dialogueExamples: expand(card.mes_example),
        };
        const definitions = new Map((settings.prompts ?? []).map(prompt => [prompt.identifier, prompt]));
        const defaultMain = 'You are {{char}}, a persistent personal assistant. Help {{user}} with their requests.';
        const configuredMain = definitions.get('main')?.content ?? settings.main_prompt ?? defaultMain;
        values.original = configuredMain;
        fields.main = expand(binding.systemPrompt || (saved.power_user?.prefer_character_prompt !== false && card.system_prompt) || configuredMain);
        fields.jailbreak = expand((saved.power_user?.prefer_character_jailbreak !== false && card.post_history_instructions) || definitions.get('jailbreak')?.content || '');
        const globalOrder = settings.prompt_order?.find(x => Number(x.character_id) === 100000)?.order ?? settings.prompt_order?.[0]?.order;
        const order = globalOrder ?? DEFAULT_ORDER.map(identifier => ({ identifier, enabled: true }));
        const before = [];
        const after = [];
        const injections = [...lore.injections];
        let historySeen = false;
        for (const item of order) {
            if (!item.enabled) continue;
            if (item.identifier === 'chatHistory') { historySeen = true; continue; }
            const definition = definitions.get(item.identifier);
            const content = fields[item.identifier] ?? expand(definition?.content);
            if (!content) continue;
            const message = { role: ['user', 'assistant'].includes(definition?.role) ? definition.role : 'system', content };
            if (Number(definition?.injection_position) === 1) {
                injections.push({ depth: Math.max(0, Number(definition.injection_depth) || 0), message });
            } else {
                (historySeen ? after : before).push(message);
            }
        }
        if (!before.length && !after.length) before.push({ role: 'system', content: fields.main });
        request.user_name = user;
        request.char_name = name;
        for (const key of ['custom_include_body', 'custom_exclude_body', 'custom_include_headers']) {
            if (request[key]) request[key] = expand(request[key]);
        }
        return { before, after, injections, request };
    }

    lore(binding, { saved, card }, session, contextChars, expand) {
        const worldSettings = saved.world_info_settings ?? saved;
        const world = worldSettings.world_info ?? {};
        const extra = world.charLore?.find(x => x.name === path.parse(binding.character || '').name)?.extraBooks ?? [];
        const names = [...new Set([
            ...(Array.isArray(world.globalSelect) ? world.globalSelect : []), card.extensions?.world,
            saved.power_user?.persona_description_lorebook, ...extra,
        ].filter(Boolean))];
        const entries = [];
        for (const name of names) {
            try {
                const data = this.read(this.resource(this.directory('worlds', 'worlds'), `${plainName(name)}.json`));
                entries.push(...Object.values(data.entries ?? {}));
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
        }
        for (const entry of card.character_book?.entries ?? []) {
            entries.push({ ...entry, ...entry.extensions, key: entry.keys, keysecondary: entry.secondary_keys, disable: entry.enabled === false });
        }
        entries.sort((a, b) => Number(b.order ?? b.insertion_order ?? 100) - Number(a.order ?? a.insertion_order ?? 100));
        const result = { before: [], after: [], injections: [] };
        const budget = Math.min(Math.floor(contextChars * 0.3), 60000);
        let used = 0;
        for (const entry of entries) {
            if (entry.disable || !entry.content || entry.vectorized || entry.useProbability && Number(entry.probability) === 0) continue;
            const depth = Math.max(1, Math.min(100, Number(entry.scanDepth ?? worldSettings.world_info_depth ?? 2)));
            const text = session.messages.slice(-depth * 2).map(x => `${x.name ?? x.role}: ${x.content}`).join('\n');
            const sensitive = entry.caseSensitive ?? worldSettings.world_info_case_sensitive;
            const haystack = sensitive ? text : text.toLocaleLowerCase();
            const matches = key => haystack.includes(sensitive ? expand(key) : expand(key).toLocaleLowerCase());
            if (!entry.constant) {
                if (!Array.isArray(entry.key) || !entry.key.filter(key => typeof key === 'string' && key.trim()).some(matches)) continue;
                const secondary = entry.keysecondary ?? [];
                if (entry.selective && secondary.length) {
                    const any = secondary.some(matches), all = secondary.every(matches);
                    const accepted = [any, !all, !any, all][entry.selectiveLogic ?? 0];
                    if (!accepted) continue;
                }
            }
            const content = expand(entry.content);
            if (used + content.length > budget) continue;
            used += content.length;
            if (Number(entry.position) === 4) {
                result.injections.push({ depth: Math.max(0, Number(entry.depth) || 0), message: { role: ['system', 'user', 'assistant'][entry.role ?? 0] || 'system', content } });
            } else {
                (Number(entry.position) === 0 || entry.position === 'before_char' ? result.before : result.after).push(content);
            }
        }
        return result;
    }
}
