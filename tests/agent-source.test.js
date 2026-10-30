import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { GatewaySource, buildGatewayRequest } from '../src/agent/source.js';

let root;
let source;
let settings;
const write = (file, value) => fs.writeFileSync(path.join(root, file), JSON.stringify(value));
beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'st-gateway-source-'));
    for (const directory of ['characters', 'worlds', 'OpenAI Settings']) fs.mkdirSync(path.join(root, directory));
    settings = {
        name1: 'Alice', power_user: { persona_description: 'Alice is a scientist.' },
        world_info_settings: { world_info: { globalSelect: ['Knowledge'] } },
        oai_settings: {
            chat_completion_source: 'custom', custom_model: 'local-model', custom_url: 'http://127.0.0.1:10000/v1',
            openai_max_tokens: 200, temp_openai: 0.8,
            prompts: [{ identifier: 'main', role: 'system', content: 'Help {{user}} as {{char}}.' }, { identifier: 'jailbreak', content: 'Last instruction.' }],
        },
    };
    write('settings.json', settings);
    write('characters/Agent.json', { data: { name: 'Ada', description: 'Expert researcher', personality: 'Precise', scenario: 'A laboratory', mes_example: 'Alice: Hello\nAda: Hello Alice' } });
    write('worlds/Knowledge.json', { entries: {
        one: { key: ['nebula'], content: '{{char}} knows that a nebula contains gas.', position: 0 },
        two: { constant: true, content: 'Permanent lore.', position: 1 },
        three: { key: ['secret'], disable: true, content: 'Disabled lore must never appear.' },
    } });
    source = new GatewaySource({ root });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('gateway-owned ST source loading', () => {
    test('loads a native ST PNG character card directly on the server', () => {
        fs.copyFileSync(new URL('../default/content/default_Seraphina.png', import.meta.url), path.join(root, 'characters', 'Seraphina.png'));
        fs.copyFileSync(new URL('../default/content/Eldoria.json', import.meta.url), path.join(root, 'worlds', 'Eldoria.json'));
        const { binding } = source.bind({ character: 'Seraphina.png' });
        expect(binding.name).toBe('Seraphina');
        const prepared = source.prepare(binding, { messages: [] }, 24000);
        expect(JSON.stringify(prepared.before)).toContain('Seraphina');
        expect(JSON.stringify(prepared.before)).toContain('Eldoria');
    });

    test('binds using only disk references and assembles persona, card, macros and lore without a browser', () => {
        const { binding } = source.bind({ character: 'Agent.json' });
        const prepared = source.prepare(binding, { messages: [{ role: 'user', content: 'Explain a nebula' }] }, 24000);
        expect(prepared.request.model).toBe('local-model');
        expect(prepared.request.custom_url).toBe('http://127.0.0.1:10000/v1');
        const prompt = JSON.stringify(prepared.before);
        expect(prompt).toContain('Help Alice as Ada.');
        expect(prompt).toContain('Expert researcher');
        expect(prompt).toContain('Alice is a scientist');
        expect(prompt).toContain('Ada knows that a nebula contains gas.');
        expect(prompt).toContain('Permanent lore');
        expect(prompt).not.toContain('Disabled lore');
        expect(prepared.after).toEqual([{ role: 'system', content: 'Last instruction.' }]);
    });

    test('expands a card original-prompt macro without a browser and tolerates a removed optional lorebook', () => {
        write('characters/Agent.json', { name: 'Ada', system_prompt: '{{original}} Always be concise.', extensions: { world: 'Removed book' } });
        const { binding } = source.bind({ character: 'Agent.json' });
        const prepared = source.prepare(binding, { messages: [] }, 24000);
        expect(JSON.stringify(prepared.before)).toContain('Help Alice as Ada. Always be concise.');
        expect(JSON.stringify(prepared.before)).not.toContain('{{original}}');
    });

    test('reads changes to models, cards, presets and keyword lore on subsequent turns', () => {
        const { binding } = source.bind({ character: 'Agent.json' });
        source.prepare(binding, { messages: [] }, 24000);
        settings.oai_settings.custom_model = 'updated-model';
        write('settings.json', settings);
        write('characters/Agent.json', { name: 'Updated Ada', description: 'A changed character description' });
        write('worlds/Knowledge.json', { entries: { next: { key: ['quasar'], content: 'New quasar knowledge.', position: 0 } } });
        const prepared = source.prepare(binding, { messages: [{ role: 'user', content: 'quasar' }] }, 24000);
        expect(prepared.request.model).toBe('updated-model');
        expect(JSON.stringify(prepared.before)).toContain('Updated Ada');
        expect(JSON.stringify(prepared.before)).toContain('changed character');
        expect(JSON.stringify(prepared.before)).toContain('New quasar knowledge');
        expect(JSON.stringify(prepared.before)).not.toContain('nebula');
    });

    test('honors a saved preset order, disabled prompts, output limit and sampler aliases', () => {
        write('OpenAI Settings/Research.json', {
            temperature: 0.2, openai_max_tokens: 333,
            prompts: [{ identifier: 'main', content: 'Research assistant' }, { identifier: 'post', role: 'system', content: 'Cite sources' }, { identifier: 'off', content: 'Hidden' }],
            prompt_order: [{ character_id: 100000, order: [
                { identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true },
                { identifier: 'post', enabled: true }, { identifier: 'off', enabled: false },
            ] }],
        });
        const { binding } = source.bind({ preset: 'Research' });
        const prepared = source.prepare(binding, { messages: [] }, 24000);
        expect(prepared.before).toEqual([{ role: 'system', content: 'Research assistant' }]);
        expect(prepared.after).toEqual([{ role: 'system', content: 'Cite sources' }]);
        expect(prepared.request.temperature).toBe(0.2);
        expect(prepared.request.max_tokens).toBe(333);
    });

    test('matches only this session, handles selective lore and preserves depth injections', () => {
        write('worlds/Knowledge.json', { entries: {
            conditional: { key: ['nebula'], selective: true, keysecondary: ['gas'], selectiveLogic: 3, content: 'Selective fact', position: 4, depth: 2 },
        } });
        const { binding } = source.bind({});
        const privateTurn = source.prepare(binding, { messages: [{ role: 'user', content: 'nebula gas' }] }, 24000);
        const groupTurn = source.prepare(binding, { messages: [{ role: 'user', content: 'Hello group' }] }, 24000);
        expect(privateTurn.injections).toEqual([{ depth: 2, message: { role: 'system', content: 'Selective fact' } }]);
        expect(groupTurn.injections).toEqual([]);
    });

    test('accepts direct gateway connection parameters with no saved settings or character', () => {
        fs.unlinkSync(path.join(root, 'settings.json'));
        const configured = source.bind({ connection: { chat_completion_source: 'custom', model: 'headless-model', custom_url: 'http://localhost:10000/v1' } });
        expect(configured.binding.mode).toBe('gateway');
        expect(configured.binding.model).toBe('headless-model');
    });

    test('rejects traversal, cross-account symlinks, browser snapshots and invalid model settings', () => {
        expect(() => source.bind({ character: '../settings.json' })).toThrow();
        expect(() => source.bind({ preset: '../../outside' })).toThrow();
        expect(() => source.bind({ systemMessages: [{}] })).toThrow('browser prompt snapshots');
        fs.symlinkSync(path.join(root, 'settings.json'), path.join(root, 'characters', 'escape.json'));
        expect(() => source.bind({ character: 'escape.json' })).toThrow('outside');
        expect(() => source.bind({ connection: { model: '', chat_completion_source: 'custom' } })).toThrow();
        expect(source.catalog()).toEqual({ characters: ['Agent.json', 'escape.json'], presets: [] });
    });
});

describe('gateway model parameter mapping', () => {
    test('maps reasoning model output limits and forces direct nonstreaming text', () => {
        const request = buildGatewayRequest({ chat_completion_source: 'openai', openai_model: 'gpt-5', openai_max_tokens: 500, temp_openai: 0.5 }, { stream: true, tools: [{}] });
        expect(request.max_completion_tokens).toBe(500);
        expect(request.max_tokens).toBeUndefined();
        expect(request.temperature).toBeUndefined();
        expect(request.stream).toBe(false);
        expect(request.tools).toBeUndefined();
    });

    test('maps Gemini and provider-specific ranges', () => {
        expect(buildGatewayRequest({ chat_completion_source: 'makersuite', google_model: 'gemini', use_sysprompt: true }).model).toBe('gemini');
        expect(buildGatewayRequest({ chat_completion_source: 'minimax', minimax_model: 'M2', temp_openai: 0 }).temperature).toBeGreaterThan(0);
        expect(buildGatewayRequest({ chat_completion_source: 'deepseek', deepseek_model: 'chat', top_p_openai: 0 }).top_p).toBeGreaterThan(0);
    });
});
