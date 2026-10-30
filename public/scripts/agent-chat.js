import {
    chat, chat_metadata, characters, this_chid, name1, setSendButtonState, deactivateSendButtons,
    getRequestHeaders, saveChat, redisplayChat, scrollChatToBottom,
} from '../script.js';
import { selected_group } from './group-chats.js';
import { eventSource, event_types } from './events.js';
import { AgentGatewayClient } from './extensions/agent/gateway-client.js';

let state;
let nativeChat;
let dirty = false;
let rendering = Promise.resolve();
const listeners = new Set();
const waiting = new Set();

export async function agentHttp(route, body) {
    const response = await fetch(`/api/agent/${route}`, {
        method: body === undefined ? 'GET' : 'POST', headers: getRequestHeaders(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `请求失败：${response.status}`);
    return data;
}

export const agentGateway = new AgentGatewayClient({ getTicket: () => agentHttp('gateway-ticket', {}) });

export function currentAgentChat() {
    const character = characters[this_chid];
    return !selected_group && character ? { avatar: character.avatar, file: character.chat } : null;
}

function matches(target) {
    const current = currentAgentChat();
    return current && target && current.avatar === target.avatar && current.file === target.file;
}

export function onAgentState(listener) {
    listeners.add(listener);
    if (state) listener(state);
    return () => listeners.delete(listener);
}

export function getAgentChatModel() {
    return agentGateway.socket?.readyState === 1 && state?.config.enabled && state.status.running && matches(state.config.binding?.chat) ? state.config.binding.model || 'Agent' : undefined;
}

export function markAgentChatDirty(target = currentAgentChat()) {
    if (matches(target) && matches(state?.config.binding?.chat)) dirty = true;
}

/** Reuse ST's own messages and renderer. Never replace a draft or an unsaved edit. */
function synchronize(document, expected) {
    rendering = rendering.then(async () => {
        if (!matches(document)) return;
        const local = JSON.stringify(chat);
        if (expected !== undefined && expected !== local) return;
        if (expected === undefined && (documentIsEditing() || dirty)) return;
        const next = JSON.stringify(document.messages);
        Object.assign(chat_metadata, document.header.chat_metadata);
        dirty = false;
        if (next === local) return;
        const bottom = $('#chat')[0].scrollHeight - $('#chat')[0].scrollTop - $('#chat')[0].clientHeight < 100;
        let first = 0;
        while (first < chat.length && first < document.messages.length && JSON.stringify(chat[first]) === JSON.stringify(document.messages[first])) first++;
        const oldIds = new Set(chat.map(message => message.extra?.agent?.id));
        chat.splice(0, chat.length, ...structuredClone(document.messages));
        await redisplayChat({ startIndex: first, fade: false });
        if (bottom) scrollChatToBottom();
        for (let index = first; index < chat.length; index++) {
            const message = chat[index];
            if (oldIds.has(message.extra?.agent?.id)) continue;
            await eventSource.emit(message.is_user ? event_types.MESSAGE_SENT : event_types.MESSAGE_RECEIVED, index);
            await eventSource.emit(message.is_user ? event_types.USER_MESSAGE_RENDERED : event_types.CHARACTER_MESSAGE_RENDERED, index);
        }
    }).catch(error => console.error('Unable to display agent chat:', error));
    return rendering;
}

function documentIsEditing() {
    return Boolean(document.querySelector('#chat .edit_textarea, #chat .reasoning_edit_textarea'));
}

export function acceptAgentChatSave(document, expectedMessages) {
    if (!document) return;
    nativeChat = document;
    return synchronize(document, JSON.stringify(expectedMessages));
}

export function refreshAgentChat() {
    if (nativeChat) return synchronize(nativeChat);
}

function receive(latest) {
    state = latest;
    for (const listener of listeners) listener(latest);
    if (latest.session?.chat) {
        nativeChat = latest.session.chat;
        synchronize(nativeChat);
    }
    for (const check of waiting) check();
    eventSource.emit(event_types.AGENT_STATUS_CHANGED);
}

export function initAgentChat() {
    agentGateway.onSnapshot(receive);
    agentGateway.onConnection(() => eventSource.emit(event_types.AGENT_STATUS_CHANGED));
    eventSource.on(event_types.CHAT_CHANGED, () => {
        dirty = false;
        agentGateway.request('subscribe', { session: 'main' }).catch(error => console.debug('Agent gateway:', error));
        eventSource.emit(event_types.AGENT_STATUS_CHANGED);
    });
    agentGateway.request('subscribe', { session: 'main' }).catch(error => console.debug('Agent gateway:', error));
}

function waitForJob(id, signal) {
    return new Promise((resolve, reject) => {
        const finish = error => {
            waiting.delete(check);
            signal?.removeEventListener('abort', abort);
            error ? reject(error) : resolve();
        };
        const check = () => {
            const job = state?.queue.find(job => job.id === id);
            if (job?.error) finish(new Error(job.error));
            else if (state && !job) finish();
        };
        const abort = () => {
            agentGateway.request('cancel', { id }).catch(error => toastr.error(error.message));
            finish(new Error('已停止本次生成。'));
        };
        waiting.add(check);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) abort();
        else check();
    });
}

/** Return false for ordinary chats; a bound main uses the same native composer. */
export async function generateAgentChat(type, signal) {
    if (!['normal', 'regenerate', 'swipe', 'continue', undefined].includes(type)) return false;
    if (!state) state = await agentGateway.request('status');
    if (!state.config.enabled || !matches(state.config.binding?.chat)) return false;
    if (!state.status.running) throw new Error('主会话后台尚未启动，请检查 Agent 设置。');
    const target = currentAgentChat();
    setSendButtonState(true);
    deactivateSendButtons();
    const textarea = document.querySelector('#send_textarea');
    const text = textarea.value;
    // Persist normal message edits/swipe choices before the gateway builds its context.
    if (await saveChat() === false) throw new Error('聊天修改尚未保存，请重新载入后重试。');
    const result = await agentGateway.request('message', {
        session: 'main', chat: target, text, name: name1,
        operation: !type || type === 'normal' ? text.trim() ? 'normal' : 'reply' : chat.at(-1)?.is_user ? 'reply' : type,
    });
    if (matches(target) && textarea.value === text && (!type || type === 'normal')) {
        textarea.value = '';
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }
    // A snapshot may complete before the command acknowledgement arrives.
    const latest = await agentGateway.request('status');
    state = { ...state, ...latest };
    await waitForJob(result.id, signal);
    await rendering;
    return true;
}
