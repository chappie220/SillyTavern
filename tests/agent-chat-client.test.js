import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const chat = [];
const chatMetadata = {};
const target = { avatar: 'CHAPPIE.png', file: 'Render regression' };
let rendered;
let snapshot;
const events = { on: jest.fn(), emit: jest.fn(async () => {}) };
const redisplayChat = jest.fn(async ({ startIndex }) => {
    rendered.splice(startIndex, rendered.length - startIndex, ...structuredClone(chat.slice(startIndex)));
});
jest.unstable_mockModule('../public/script.js', () => ({
    chat, chat_metadata: chatMetadata, characters: [{ avatar: target.avatar, chat: target.file }], this_chid: 0, name1: 'Tester',
    setSendButtonState: jest.fn(), deactivateSendButtons: jest.fn(), getRequestHeaders: jest.fn(),
    saveChat: jest.fn(), redisplayChat, scrollChatToBottom: jest.fn(),
}));
jest.unstable_mockModule('../public/scripts/group-chats.js', () => ({ selected_group: null }));
jest.unstable_mockModule('../public/scripts/events.js', () => ({
    eventSource: events,
    event_types: Object.fromEntries(['MESSAGE_SENT', 'MESSAGE_RECEIVED', 'USER_MESSAGE_RENDERED', 'CHARACTER_MESSAGE_RENDERED', 'CHAT_CHANGED', 'AGENT_STATUS_CHANGED'].map(key => [key, key])),
}));
jest.unstable_mockModule('../public/scripts/extensions/agent/gateway-client.js', () => ({
    AgentGatewayClient: class {
        onSnapshot(listener) { snapshot = listener; }
        onConnection() {}
        async request() { return {}; }
    },
}));
const { acceptAgentChatSave, initAgentChat, refreshAgentChat } = await import('../public/scripts/agent-chat.js');

const message = (text, user, id) => ({
    name: user ? 'Tester' : 'CHAPPIE', is_user: user, is_system: false, mes: text, send_date: '2026-10-31',
    extra: id ? { agent: { id, source: user ? 'chat' : 'gateway' } } : {},
});
const documentFor = (messages, revision = 'saved') => ({ ...target, header: { chat_metadata: { agent_revision: revision } }, messages });
beforeEach(() => {
    chat.splice(0, chat.length, message('Hello', false, 'greeting'));
    rendered = structuredClone(chat);
    for (const key of Object.keys(chatMetadata)) delete chatMetadata[key];
    jest.clearAllMocks();
    globalThis.document = { querySelector: jest.fn(() => null) };
    globalThis.$ = () => [{ scrollHeight: 100, scrollTop: 0, clientHeight: 100 }];
    initAgentChat();
    snapshot({ config: { enabled: false, binding: { chat: target } }, status: { running: false }, queue: [] });
});
afterEach(() => { delete globalThis.document; delete globalThis.$; });

describe('native chat save acknowledgements', () => {
    test('does not render a pending native user append when the save only adds agent metadata', async () => {
        const outgoing = message('One send', true);
        chat.push(outgoing);
        const saved = structuredClone(chat);
        saved.at(-1).extra.agent = { id: 'new-user', source: 'chat' };
        await acceptAgentChatSave(documentFor(saved), structuredClone(chat));
        // The ordinary sendMessageAsUser renderer runs after saveChat returns.
        rendered.push(outgoing);
        expect(rendered.map(row => row.mes)).toEqual(['Hello', 'One send']);
        expect(redisplayChat).not.toHaveBeenCalled();
        expect(chat.at(-1).extra.agent.id).toBe('new-user');
        expect(chatMetadata.agent_revision).toBe('saved');
    });

    test('keeps several ordinary sends single while preserving server identities and subsequent replies', async () => {
        for (let index = 0; index < 3; index++) {
            const outgoing = message(`Question ${index}`, true);
            chat.push(outgoing);
            const saved = structuredClone(chat);
            saved.at(-1).extra.agent = { id: `user-${index}`, source: 'chat' };
            await acceptAgentChatSave(documentFor(saved, `revision-${index}`), structuredClone(chat));
            rendered.push(outgoing);
            const reply = message(`Answer ${index}`, false, `reply-${index}`);
            snapshot({ config: { enabled: false, binding: { chat: target } }, status: { running: false }, queue: [], session: { chat: documentFor([...structuredClone(chat), reply]) } });
            await refreshAgentChat();
        }
        expect(rendered.map(row => row.mes)).toEqual(['Hello', 'Question 0', 'Answer 0', 'Question 1', 'Answer 1', 'Question 2', 'Answer 2']);
        expect(chat).toHaveLength(7);
        expect(redisplayChat).toHaveBeenCalledTimes(3);
        expect(events.emit.mock.calls.filter(([type]) => type === 'USER_MESSAGE_RENDERED')).toHaveLength(0);
        expect(events.emit.mock.calls.filter(([type]) => type === 'CHARACTER_MESSAGE_RENDERED')).toHaveLength(3);
    });

    test('still redraws changed text from a background snapshot', async () => {
        const changed = [message('Edited greeting', false, 'greeting')];
        snapshot({ config: { enabled: false, binding: { chat: target } }, status: {}, queue: [], session: { chat: documentFor(changed) } });
        await refreshAgentChat();
        expect(rendered.map(row => row.mes)).toEqual(['Edited greeting']);
        expect(redisplayChat).toHaveBeenCalledTimes(1);
    });

    test('still removes messages deleted in the authoritative document', async () => {
        chat.push(message('Remove this reply', false, 'deleted'));
        rendered = structuredClone(chat);
        await acceptAgentChatSave(documentFor([chat[0]]), structuredClone(chat));
        expect(rendered.map(row => row.mes)).toEqual(['Hello']);
        expect(redisplayChat).toHaveBeenCalledWith({ startIndex: 1, fade: false });
    });

    test('does not overwrite a newer local edit with a late save acknowledgement', async () => {
        const submitted = structuredClone(chat);
        chat[0].mes = 'New unsaved edit';
        await acceptAgentChatSave(documentFor(submitted), submitted);
        expect(chat[0].mes).toBe('New unsaved edit');
        expect(redisplayChat).not.toHaveBeenCalled();
    });
});
