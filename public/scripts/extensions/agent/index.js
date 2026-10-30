import { characters, this_chid, saveChat } from '../../../script.js';
import { renderExtensionTemplateAsync } from '../../extensions.js';
import { uuidv4 } from '../../utils.js';
import { agentGateway as gateway, agentHttp as http, onAgentState, currentAgentChat } from '../../agent-chat.js';

let state;
let tasks = [];
let panel;
let refreshing = false;
const connectionStates = { connected: '已连接', connecting: '连接中', reconnecting: '重连中', disconnected: '未连接' };
const input = id => panel.querySelector(`#st_agent_${id}`);

function api(route, body) {
    return ['status', 'message', 'retry'].includes(route) ? gateway.request(route, body) : http(route, body);
}

function showStatus() {
    const status = state.status;
    input('status').textContent = `网关已连接 · ${status.running ? '后台运行中' : '后台已停止'} · ${status.busy ? '正在处理' : '空闲'} · 队列 ${status.queued} · QQ ${connectionStates[status.qq.state] ?? status.qq.state}`;
    input('error').textContent = status.lastError || status.qq.error || '';
    const binding = state.config.binding;
    input('binding').textContent = binding ? `${binding.name} · ${binding.chat ? binding.chat.file : '尚未绑定角色聊天'} · ${binding.source} / ${binding.model}` : '尚未绑定角色聊天';
    input('secret').placeholder = state.hasQQSecret ? '已保存；留空不更改' : '尚未设置';
    const discovered = status.observedSender;
    input('discovery').textContent = discovered ? `最近收到：${discovered.openId}${discovered.groupId ? `（群：${discovered.groupId}）` : '（私聊）'}` : '';
    input('use_sender').hidden = !discovered || Boolean(discovered.groupId);
}

function fillForm() {
    const config = state.config;
    input('preset').value = config.binding?.preset ?? '';
    input('enabled').checked = config.enabled;
    input('context').value = config.contextChars;
    input('memory').value = config.memory;
    input('heartbeat').value = config.heartbeatMinutes;
    input('heartbeat_prompt').value = config.heartbeatPrompt;
    input('heartbeat_qq').checked = config.heartbeatToQQ;
    input('qq_enabled').checked = config.qq.enabled;
    input('appid').value = config.qq.appId;
    input('owner').value = config.qq.ownerOpenId;
    input('sandbox').checked = config.qq.sandbox;
    input('groups').value = config.qq.allowedGroups.join('\n');
    tasks = structuredClone(config.tasks);
    renderTasks();
}

function renderTasks() {
    const container = input('tasks');
    container.replaceChildren();
    for (const task of tasks) {
        const row = document.createElement('div');
        row.className = 'st-agent-task';
        const text = document.createElement('div');
        text.textContent = task.prompt;
        const detail = document.createElement('small');
        detail.textContent = `${new Date(task.at).toLocaleString()} · ${task.intervalMinutes ? `每 ${task.intervalMinutes} 分钟` : '一次性'} · ${task.target === 'qq' ? 'QQ' : 'main'}`;
        const enabled = document.createElement('input');
        enabled.type = 'checkbox';
        enabled.checked = task.enabled;
        enabled.setAttribute('aria-label', '启用此任务');
        enabled.addEventListener('change', () => { task.enabled = enabled.checked; });
        const remove = document.createElement('button');
        remove.className = 'menu_button';
        remove.type = 'button';
        remove.textContent = '移除';
        remove.addEventListener('click', () => { tasks = tasks.filter(x => x.id !== task.id); renderTasks(); });
        row.append(enabled, text, detail, remove);
        container.append(row);
    }
}

async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
        state = await api('status');
        showStatus();
    } catch (error) {
        input('error').textContent = error.message;
    } finally {
        refreshing = false;
    }
}

async function bind() {
    const chat = currentAgentChat();
    if (!chat) throw new Error('请先打开要作为 main 的角色聊天。');
    if (await saveChat() === false) throw new Error('聊天尚未保存，请重试。');
    state = await api('bind', { character: characters[this_chid].avatar, chat, preset: input('preset').value });
    showStatus();
    toastr.success('当前角色聊天已设为 main，继续使用原来的聊天窗口即可。');
}

async function loadCatalog() {
    const catalog = await api('catalog');
    for (const [id, values, empty] of [['preset', catalog.presets, '跟随 ST 已保存的当前设置']]) {
        input(id).replaceChildren();
        const option = document.createElement('option');
        option.value = '';
        option.textContent = empty;
        input(id).append(option);
        for (const value of values) {
            const item = document.createElement('option');
            item.value = item.textContent = value;
            input(id).append(item);
        }
    }
}

async function save() {
    const config = {
        enabled: input('enabled').checked,
        contextChars: Number(input('context').value),
        memory: input('memory').value,
        heartbeatMinutes: Number(input('heartbeat').value),
        heartbeatPrompt: input('heartbeat_prompt').value,
        heartbeatToQQ: input('heartbeat_qq').checked,
        qq: {
            enabled: input('qq_enabled').checked,
            appId: input('appid').value,
            ownerOpenId: input('owner').value,
            sandbox: input('sandbox').checked,
            allowedGroups: input('groups').value.split(/[\s,，]+/).filter(Boolean),
        },
        tasks,
    };
    if (input('secret').value) config.qqSecret = input('secret').value;
    state = await api('config', config);
    input('secret').value = '';
    fillForm();
    showStatus();
    toastr.success('后台设置已应用。');
}

function addTask() {
    const prompt = input('task_prompt').value.trim();
    const at = new Date(input('task_at').value);
    const intervalMinutes = Number(input('task_interval').value);
    if (!prompt || !Number.isFinite(at.getTime())) throw new Error('请填写任务内容和首次执行时间。');
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 0) throw new Error('重复间隔须为非负整数。');
    tasks.push({ id: uuidv4(), prompt, at: at.toISOString(), intervalMinutes, enabled: true, target: input('task_target').value });
    input('task_prompt').value = '';
    renderTasks();
    toastr.info('任务已添加，请点击“保存并应用”。');
}

export async function init() {
    const html = await renderExtensionTemplateAsync('agent', 'settings');
    $('#extensions_settings').before(html);
    panel = document.querySelector('#st_agent');
    function action(id, callback) {
        input(id).addEventListener('click', async () => {
            input(id).disabled = true;
            try {
                await callback();
            } catch (error) {
                toastr.error(error.message);
            } finally {
                input(id).disabled = false;
            }
        });
    }
    action('bind', bind);
    action('save', save);
    action('task_add', addTask);
    action('retry', async () => { state = await api('retry', {}); showStatus(); });
    action('use_sender', () => { input('owner').value = state.status.observedSender.openId; toastr.info('已填写，请保存并应用。'); });
    onAgentState(latest => { state = latest; showStatus(); });
    gateway.onConnection(connected => { if (!connected) input('status').textContent = '网关断开，正在重连…'; });
    await Promise.all([refresh(), loadCatalog()]);
    if (state) fillForm();
    panel.querySelector('.inline-drawer-toggle').addEventListener('click', refresh);
}
