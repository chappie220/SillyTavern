import {
    characters, closeCurrentChat, doNavbarIconClick, event_types, eventSource,
    getCurrentChatId, getThumbnailUrl, main_api, name1, name2, newAssistantChat,
    online_status, saveSettingsDebounced, selectCharacterById, setActiveCharacter, setActiveGroup, this_chid,
} from '../script.js';
import { addLocaleData, applyLocale, getCurrentLocale, t } from './i18n.js';
import { openWelcomeScreen } from './welcome-screen.js';
import { groups, openGroupById, selected_group } from './group-chats.js';
import { initializeWorkspacePages, isWorkspacePage, navigateWorkspace, restoreWorkspacePage, syncWorkspacePages } from './workspace-pages.js';

const panelNames = {
    'ai-config-button': 'Response settings',
    'sys-settings-button': 'API Connections',
    'WI-SP-button': 'Worlds/Lorebooks',
    'user-settings-button': 'User Settings',
    'extensions-settings-button': 'Extensions',
    'persona-management-button': 'Personas',
    'rightNavHolder': 'Your characters',
    'backgrounds-button': 'Backgrounds',
    'advanced-formatting-button': 'Prompt format',
};

const themeStorageKey = 'SillyTavern.workspaceTheme';

const chinese = {
    'Home': '首页', 'Your workspace': '我的工作区', 'New chat': '新对话',
    'Characters': '角色', 'World info': '世界书', 'Personas': '用户角色',
    'Tools & settings': '工具与设置', 'Response settings': '回复设置', 'Prompt format': '提示词格式',
    'Connections': '模型连接', 'Appearance': '外观', 'Your collection': '我的角色',
    'Search characters': '搜索角色', 'Search characters…': '搜索角色…',
    'Switch color theme': '切换明暗主题', 'Open navigation': '打开导航',
    'Close navigation': '关闭导航', 'Close panel': '关闭面板', 'Close search': '关闭搜索',
    'A little imagination starts here.': '让想象，从这里开始。',
    'Your characters, your worlds, your next great conversation.': '你的角色、你的世界，还有下一段精彩对话。',
    'A space for your stories': '故事，由你开启',
    'Where will the conversation take you?': '下一段对话，会带你去哪里？',
    'Meet a character. Dream up a world. See what unfolds, one message at a time.': '遇见一个角色，构想一个世界。在一来一往的交谈中，让故事自然发生。',
    'Find a character': '寻找角色', 'Just start talking': '随心聊聊',
    'An open canvas for any idea': '让每一个想法都有回应',
    'Create a character': '创建角色', 'Give a new personality a voice': '赋予新的性格，新的声音',
    'Build a world': '构建世界', 'Add a little depth to your stories': '为故事增添丰富的背景',
    'Your next conversation belongs here': '下一段对话，就从这里开始',
    'Start a chat with a character and pick it up here anytime.': '与角色开启对话，随时在这里继续。',
    'Start a chat': '开始聊天', 'Your characters': '我的角色', 'View all': '查看全部',
    'Made for the stories only you can tell.': '为只有你能讲述的故事而生。',
    'Documentation': '使用文档', 'Community': '社区', 'Import a character': '导入角色',
    'Bring someone new into your world.': '让新角色走进你的世界。',
    'Ready for a new conversation': '开启一段全新的对话',
    'Connect a model to start chatting': '连接模型，开始聊天',
    'Set up connection': '设置连接', 'Connected': '已连接', 'Not connected': '未连接',
    'No matching characters': '没有找到匹配的角色',
    'Try another name or import a new character.': '换个名字搜索，或导入新的角色。',
    'Choose a character to start a conversation.': '选择一个角色，开启对话。',
    'Go to character collection': '前往角色列表', 'Favorite': '收藏',
    'Character library': '角色库', 'Settings': '设置', 'Back to chat': '返回对话', 'Back to home': '返回首页',
    'Find a familiar voice or give someone new a story.': '遇见熟悉的声音，或为新角色开启一个故事。',
    'Write the places, history, and details your characters should remember.': '记录角色应当记住的地点、历史和故事细节。',
    'Choose who you are in each conversation.': '为每段对话选择你的身份。',
    'Shape how your model writes and responds.': '调整模型的表达方式与回复风格。',
    'Configure the context and instructions sent to your model.': '管理发送给模型的上下文与指令。',
    'Connect a model and manage your connection profiles.': '连接模型，管理不同的连接方案。',
    'Add new abilities and configure the tools in your workspace.': '为工作区添加新的能力，配置常用工具。',
    'Choose the backdrop for your conversations.': '为你的对话选择合适的背景。',
    'Make the workspace feel right for you.': '按你的习惯调整工作区。',
    'Search by name or tag…': '搜索角色名称或标签…', 'Sort by': '排序',
    'More character tools': '更多角色工具', 'Filter characters': '筛选角色',
    'All characters': '全部角色', 'Create lorebook': '创建世界书', 'Edit character': '编辑角色',
    'Bring your own model': '使用你选择的模型',
    'Choose your provider, enter its connection details, then select a model. You can save different setups as connection profiles.': '选择服务商，填写连接信息，然后选择模型。不同的配置可以保存为独立的连接方案。',
    'Connection guide': '连接指南', 'Search extensions': '搜索扩展', 'No matching extensions': '没有找到匹配的扩展',
    'No groups here yet': '还没有聊天群组', 'No favorite characters yet': '还没有收藏角色',
    'Try another search or add someone new to your collection.': '换个关键词搜索，或为角色库添加一个新角色。',
    'Create a group': '创建群组', 'Show all characters': '查看全部角色',
    'Groups': '聊天群组', 'Every world starts with a detail': '每个世界，都从一个细节开始',
    'Create a lorebook or choose one above to start writing.': '创建一本世界书，或从上方选择已有的世界书，开始书写。',
    '${0} characters': '${0} 个角色', '${0} groups': '${0} 个群组', '${0} members': '${0} 位成员',
    '${0} character': '${0} 个角色', '${0} group': '${0} 个群组',
    'Model connections': '模型连接', 'Installed extensions': '已安装扩展',
};

/** Escape dynamic text before inserting it in a template or attribute. */
function escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[char]));
}

function icon(name) {
    return `<i class="fa-solid fa-${name}" aria-hidden="true"></i>`;
}

function actionButton(action, glyph, label, extra = '') {
    return `<button type="button" class="ws-nav-link ${extra}" data-workspace-action="${action}">${icon(glyph)}<span>${escape(label)}</span></button>`;
}

function createShell() {
    const shell = document.createElement('div');
    shell.id = 'workspace-shell';
    shell.innerHTML = `
        <button type="button" id="workspace-nav-shade" class="ws-shade" data-workspace-action="close-menu" aria-label="${escape(t`Close navigation`)}"></button>
        <aside id="workspace-sidebar" aria-label="${escape(t`Your workspace`)}">
            <a href="/" class="ws-brand" data-workspace-action="home"><span class="ws-brand-mark">${icon('hat-wizard')}</span><span>SillyTavern<span class="ws-brand-subtitle">${escape(t`Your workspace`)}</span></span></a>
            <button type="button" class="ws-icon-button ws-mobile-close" data-workspace-action="close-menu" aria-label="${escape(t`Close navigation`)}">${icon('xmark')}</button>
            <button type="button" class="ws-new-chat" data-workspace-action="assistant">${icon('plus')}<span>${escape(t`New chat`)}</span><kbd>⌘ ↵</kbd></button>
            <nav class="ws-main-nav" aria-label="${escape(t`Your workspace`)}">
                ${actionButton('home', 'house', t`Home`, 'is-active')}
                ${actionButton('characters', 'address-card', t`Character library`)}
                ${actionButton('worlds', 'book-open', t`World info`)}
                ${actionButton('personas', 'user', t`Personas`)}
            </nav>
            <div class="ws-nav-section"><span>${escape(t`Tools & settings`)}</span>
                ${actionButton('response', 'sliders', t`Response settings`)}
                ${actionButton('formatting', 'font', t`Prompt format`)}
                ${actionButton('connections', 'plug', t`Model connections`)}
                ${actionButton('extensions', 'shapes', t`Extensions`)}
                ${actionButton('backgrounds', 'image', t`Appearance`)}
                ${actionButton('settings', 'gear', t`Settings`)}
            </div>
            <div class="ws-nav-section ws-collection-nav"><div class="ws-collection-label"><span>${escape(t`Your collection`)}</span><button type="button" class="ws-icon-button" data-workspace-action="characters" aria-label="${escape(t`Go to character collection`)}">${icon('plus')}</button></div><div id="workspace-favorites"></div></div>
            <div class="ws-sidebar-bottom">
                <button type="button" class="ws-connection-card" data-workspace-action="connections"><span class="ws-connection-dot"></span><span><strong class="ws-status-label">${escape(t`Not connected`)}</strong><small>${escape(t`Set up connection`)}</small></span>${icon('chevron-right')}</button>
                <button type="button" class="ws-profile" data-workspace-action="settings"><span class="ws-user-avatar">${icon('user')}</span><span><strong id="workspace-user-name"></strong><small>SillyTavern</small></span>${icon('gear')}</button>
            </div>
        </aside>
        <header id="workspace-header">
            <div class="ws-header-start"><button type="button" id="workspace-menu" class="ws-icon-button" data-workspace-action="menu" aria-label="${escape(t`Open navigation`)}" aria-controls="workspace-sidebar" aria-expanded="false">${icon('bars')}</button><span class="ws-breadcrumb">${escape(t`Your workspace`)}<span>/</span><strong id="workspace-page-title">${escape(t`Home`)}</strong></span></div>
            <div class="ws-header-actions"><button type="button" class="ws-search-trigger" data-workspace-action="search" aria-label="${escape(t`Search characters`)}">${icon('magnifying-glass')}<span>${escape(t`Search characters…`)}</span><kbd>⌘ K</kbd></button><button type="button" class="ws-icon-button ws-theme-toggle" data-workspace-action="theme" aria-label="${escape(t`Switch color theme`)}" aria-pressed="false">${icon('moon')}</button><button type="button" class="ws-header-status" data-workspace-action="connections"><span class="ws-connection-dot"></span><span class="ws-status-label">${escape(t`Not connected`)}</span></button></div>
        </header>
        <button type="button" id="workspace-panel-shade" class="ws-shade" data-workspace-action="close-panel" aria-label="${escape(t`Close panel`)}"></button>
        <dialog id="workspace-search" aria-labelledby="workspace-search-title">
            <div class="ws-search-top"><label for="workspace-search-input" id="workspace-search-title">${icon('magnifying-glass')}<span class="ws-sr-only">${escape(t`Search characters`)}</span></label><input id="workspace-search-input" type="search" autocomplete="off" placeholder="${escape(t`Search characters…`)}"><button type="button" class="ws-icon-button" data-workspace-action="close-search" aria-label="${escape(t`Close search`)}">${icon('xmark')}</button></div>
            <p class="ws-search-help">${escape(t`Choose a character to start a conversation.`)}</p><div id="workspace-search-results" aria-live="polite"></div>
        </dialog>`;
    document.body.append(shell);
    document.getElementById('sheld').prepend(document.getElementById('bg1'));
    document.getElementById('sheld').setAttribute('role', 'main');
    const chatHeader = document.createElement('div');
    chatHeader.id = 'workspace-chat-header';
    chatHeader.innerHTML = `<button type="button" class="ws-icon-button" data-workspace-action="home" aria-label="${escape(t`Home`)}">${icon('chevron-left')}</button><div><strong id="workspace-chat-name"></strong><small id="workspace-chat-subtitle"></small></div><button type="button" class="ws-icon-button" data-workspace-action="characters" aria-label="${escape(t`Characters`)}">${icon('address-card')}</button>`;
    document.getElementById('sheld').prepend(chatHeader);
    const hint = document.createElement('div');
    hint.id = 'workspace-composer-hint';
    hint.innerHTML = `<button type="button" data-workspace-action="connections">${icon('plug')}<span id="workspace-composer-status"></span></button><span>Enter ↵</span>`;
    document.getElementById('form_sheld').append(hint);
    // Character editing remains a temporary surface over the current page.
    document.querySelectorAll('#rightNavHolder').forEach(drawer => {
        const panel = drawer.querySelector('.drawer-content');
        if (!panel) return;
        const heading = document.createElement('div');
        heading.className = 'ws-panel-heading';
        const label = panelNames[drawer.id] || drawer.querySelector('.drawer-icon')?.getAttribute('title') || '';
        heading.innerHTML = `<h2>${escape(t([label]))}</h2><button type="button" class="ws-icon-button" data-workspace-action="close-panel" aria-label="${escape(t`Close panel`)}">${icon('xmark')}</button>`;
        panel.prepend(heading);
        panel.setAttribute('aria-label', t([label]));
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
    });
}

let lastPanelTrigger = null;

function closePanels() {
    const panels = document.querySelectorAll('#top-settings-holder .drawer-content.openDrawer');
    panels.forEach(panel => {
        // Pinned drawers should also dismiss when the explicit close control is used.
        const toggle = panel.closest('.drawer').querySelector('.drawer-toggle');
        if (toggle) void doNavbarIconClick.call(toggle);
    });
    if (panels.length && lastPanelTrigger?.isConnected) lastPanelTrigger.focus({ preventScroll: true });
}

async function openPanel(id) {
    lastPanelTrigger = document.activeElement;
    setNavigation(false);
    const drawer = document.getElementById(id);
    const panel = drawer?.querySelector('.drawer-content');
    if (!panel) return;
    for (const other of document.querySelectorAll('#top-settings-holder .drawer-content.openDrawer')) {
        if (other !== panel) await doNavbarIconClick.call(other.closest('.drawer').querySelector('.drawer-toggle'));
    }
    if (!panel.classList.contains('openDrawer')) {
        await doNavbarIconClick.call(drawer.querySelector('.drawer-toggle'));
    }
    panel.querySelector('.ws-panel-heading button')?.focus({ preventScroll: true });
}

function setNavigation(open) {
    document.body.classList.toggle('ws-nav-open', open);
    document.getElementById('workspace-menu').setAttribute('aria-expanded', String(open));
    if (open) document.querySelector('.ws-mobile-close').focus();
}

function plainText(value) {
    const doc = new DOMParser().parseFromString(String(value || ''), 'text/html');
    return doc.body.textContent.replace(/\s+/g, ' ').trim();
}

function characterImage(character) {
    return escape(getThumbnailUrl('avatar', character.avatar));
}

function renderCollection() {
    const favorites = document.getElementById('workspace-favorites');
    const collection = [...characters].sort((a, b) => Number(Boolean(b.fav || b.data?.extensions?.fav)) - Number(Boolean(a.fav || a.data?.extensions?.fav)));
    favorites.innerHTML = collection.slice(0, 4).map(character => `<button type="button" class="ws-favorite" data-workspace-character="${escape(character.avatar)}"><img src="${characterImage(character)}" alt="" width="25" height="25"><span>${escape(character.name)}</span>${character.fav || character.data?.extensions?.fav ? icon('star') : ''}</button>`).join('') || `<button type="button" class="ws-text-button" data-workspace-action="import">${icon('plus')}${escape(t`Import a character`)}</button>`;
    const target = document.getElementById('workspace-characters');
    const signature = JSON.stringify(collection.slice(0, 3).map(c => [c.avatar, c.name, c.fav, c.creatorcomment, c.description, c.data?.creator_notes, c.data?.tags]));
    if (!target || target.dataset.rendered === signature) return;
    target.dataset.rendered = signature;
    target.innerHTML = collection.slice(0, 3).map(character => {
        const description = plainText(character.data?.creator_notes || character.creatorcomment || character.description);
        const tags = Array.isArray(character.data?.tags) ? character.data.tags.slice(0, 2) : [];
        return `<button type="button" class="ws-character-card" data-workspace-character="${escape(character.avatar)}"><img class="ws-character-cover" src="${characterImage(character)}" alt="" width="84" height="108" loading="lazy"><span class="ws-character-copy"><strong>${escape(character.name)}</strong><span class="ws-character-description">${escape(description || t`Ready for a new conversation`)}</span><span class="ws-character-tags">${tags.map(tag => `<span>${escape(tag)}</span>`).join('') || `<span>${escape(t`Start a chat`)}</span>`}</span></span>${icon('chevron-right')}</button>`;
    }).join('') + `<button type="button" class="ws-import-card" data-workspace-action="import"><span class="ws-import-icon">${icon('plus')}</span><strong>${escape(t`Import a character`)}</strong><small>${escape(t`Bring someone new into your world.`)}</small></button>`;
}

function syncWorkspace() {
    const home = Boolean(document.querySelector('#chat .welcomePanel'));
    const title = home ? t`Home` : name2 || t`New chat`;
    document.getElementById('workspace-user-name').textContent = name1;
    document.getElementById('workspace-chat-name').textContent = selected_group ? groups.find(group => group.id === selected_group)?.name || title : title;
    document.getElementById('workspace-chat-subtitle').textContent = t`Your workspace`;
    syncWorkspacePages();
    const date = document.querySelector('.ws-date');
    if (date) date.textContent = new Intl.DateTimeFormat(getCurrentLocale(), { month: 'short', day: 'numeric', weekday: 'short' }).format(new Date());
    renderCollection();
    syncConnection();
}

function syncConnection() {
    const connected = Boolean(online_status && online_status !== 'no_connection');
    document.body.classList.toggle('ws-connected', connected);
    document.querySelectorAll('.ws-status-label').forEach(label => label.textContent = connected ? t`Connected` : t`Not connected`);
    document.getElementById('workspace-composer-status').textContent = connected ? `${main_api} · ${online_status}` : t`Connect a model to start chatting`;
    document.querySelector('.ws-connection-card small').textContent = connected ? online_status : t`Set up connection`;
}

function renderSearch() {
    const query = document.getElementById('workspace-search-input').value.trim().toLocaleLowerCase();
    const results = characters.filter(character => `${character.name} ${(character.data?.tags || []).join(' ')}`.toLocaleLowerCase().includes(query)).slice(0, 20);
    document.getElementById('workspace-search-results').innerHTML = results.map(character => `<button type="button" class="ws-search-result" data-workspace-character="${escape(character.avatar)}"><img src="${characterImage(character)}" alt="" width="44" height="44"><span><strong>${escape(character.name)}</strong><small>${escape(t`Start a chat`)}</small></span>${icon('chevron-right')}</button>`).join('') || `<div class="ws-search-empty">${icon('magnifying-glass')}<strong>${escape(t`No matching characters`)}</strong><p>${escape(t`Try another name or import a new character.`)}</p><button type="button" class="ws-button ws-primary" data-workspace-action="import">${escape(t`Import a character`)}</button></div>`;
}

function showSearch() {
    setNavigation(false);
    const dialog = document.getElementById('workspace-search');
    if (dialog.open) return;
    document.getElementById('workspace-search-input').value = '';
    renderSearch();
    dialog.showModal();
    document.getElementById('workspace-search-input').focus();
}

function applyTheme(dark) {
    document.body.classList.toggle('ws-dark', dark);
    const toggle = document.querySelector('.ws-theme-toggle');
    toggle.setAttribute('aria-pressed', String(dark));
    toggle.innerHTML = icon(dark ? 'sun' : 'moon');
    document.querySelector('meta[name="theme-color"]').content = dark ? '#1c2535' : '#f5f7fb';
}

async function startCharacter(avatar) {
    document.getElementById('workspace-search').close();
    closePanels();
    setNavigation(false);
    const id = characters.findIndex(character => character.avatar === avatar);
    if (id < 0) return;
    await selectCharacterById(id, { switchMenu: false });
    // Do not change the remembered character if generation/saving prevented a switch.
    if (getCurrentChatId() !== undefined && characters[this_chid]?.avatar === avatar) {
        setActiveCharacter(avatar);
        saveSettingsDebounced();
        await navigateWorkspace('chat');
    }
    syncWorkspace();
    document.getElementById('send_textarea').focus();
}

async function handleAction(action) {
    if (isWorkspacePage(action)) return navigateWorkspace(action);
    switch (action) {
        case 'home':
            await navigateWorkspace('home');
            break;
        case 'resume-chat': await navigateWorkspace('chat'); break;
        case 'assistant':
            closePanels();
            setNavigation(false);
            // Reuse the native transition, including the guard against active generation.
            if (await closeCurrentChat()) {
                await newAssistantChat({ temporary: true });
                await navigateWorkspace('chat');
                document.getElementById('send_textarea').focus();
            }
            break;
        case 'create':
        case 'import':
            document.getElementById('workspace-search').close();
            await openPanel('rightNavHolder');
            document.getElementById(action === 'create' ? 'rm_button_create' : 'character_import_button').click();
            if (action === 'create') document.getElementById('character_name_pole').focus();
            break;
        case 'character-tools':
            await openPanel('rightNavHolder');
            document.getElementById('rm_button_characters').click();
            break;
        case 'create-group':
            await openPanel('rightNavHolder');
            document.getElementById('rm_button_group_chats').click();
            break;
        case 'create-world': document.getElementById('world_create_button').click(); break;
        case 'import-world': document.getElementById('world_import_button').click(); break;
        case 'search': showSearch(); break;
        case 'close-search': document.getElementById('workspace-search').close(); break;
        case 'close-panel': closePanels(); break;
        case 'menu': setNavigation(!document.body.classList.contains('ws-nav-open')); break;
        case 'close-menu':
            setNavigation(false);
            document.getElementById('workspace-menu').focus();
            break;
        case 'theme': {
            const dark = !document.body.classList.contains('ws-dark');
            localStorage.setItem(themeStorageKey, dark ? 'dark' : 'light');
            applyTheme(dark);
            break;
        }
    }
    syncWorkspace();
}

function bindEvents() {
    // Handle our modal surfaces before the legacy document hotkeys can toggle
    // the same drawer a second time. Native popup dialogs keep their own Escape.
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
        if (document.body.classList.contains('ws-nav-open')) {
            event.preventDefault();
            event.stopImmediatePropagation();
            setNavigation(false);
            document.getElementById('workspace-menu').focus();
        } else if (document.querySelector('#top-settings-holder .openDrawer')) {
            event.preventDefault();
            event.stopImmediatePropagation();
            closePanels();
        }
    }, true);
    document.addEventListener('click', event => {
        const target = event.target instanceof Element ? event.target : null;
        const character = target?.closest('[data-workspace-character]');
        const action = target?.closest('[data-workspace-action]');
        const edit = target?.closest('[data-workspace-edit]');
        const group = target?.closest('[data-workspace-group]');
        if (!character && !action && !edit && !group) return;
        event.preventDefault();
        const operation = edit ? editCharacter(edit.dataset.workspaceEdit) : group ? startGroup(group.dataset.workspaceGroup) : character ? startCharacter(character.dataset.workspaceCharacter) : handleAction(action.dataset.workspaceAction);
        Promise.resolve(operation).catch(error => {
            console.error('Workspace action failed:', error);
            toastr.error(t`Unable to complete this action. Please try again.`);
        });
    });
    document.getElementById('workspace-search-input').addEventListener('input', renderSearch);
    document.getElementById('workspace-search').addEventListener('click', event => {
        if (event.target === event.currentTarget) event.currentTarget.close();
    });
    document.addEventListener('keydown', event => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
            if (document.querySelector('dialog[open]:not(#workspace-search)')) return;
            event.preventDefault();
            showSearch();
        }
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && !event.target.matches('textarea, input, [contenteditable="true"]') && !document.querySelector('dialog[open]')) {
            event.preventDefault();
            void handleAction('assistant');
        }
        if (event.key === 'Escape' && !document.querySelector('dialog[open]')) {
            if (document.body.classList.contains('ws-nav-open')) {
                setNavigation(false);
                document.getElementById('workspace-menu').focus();
            } else closePanels();
        }
        const recent = event.target.closest('.recentChat[role="button"]');
        if (recent === event.target && (event.key === 'Enter' || event.key === ' ')) {
            event.preventDefault();
            recent.click();
        }
        if (event.key === 'ArrowDown' && event.target.id === 'workspace-search-input') {
            event.preventDefault();
            document.querySelector('.ws-search-result')?.focus();
        }
        if (event.key === 'Enter' && event.target.id === 'workspace-search-input') {
            event.preventDefault();
            document.querySelector('.ws-search-result')?.click();
        }
        if (event.key === 'Tab' && document.body.classList.contains('ws-nav-open')) {
            const focusable = [...document.querySelectorAll('#workspace-sidebar a, #workspace-sidebar button')].filter(element => element.getClientRects().length);
            const first = focusable[0], last = focusable.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
        }
    });
    document.addEventListener('keydown', event => {
        if (event.key !== 'Tab' || document.querySelector('dialog[open]')) return;
        const panel = document.querySelector('#top-settings-holder .openDrawer');
        if (!panel) return;
        const focusable = [...panel.querySelectorAll('button, a[href], input, select, textarea, [tabindex="0"]')].filter(element => !element.disabled && element.getClientRects().length);
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
        }
    });
    matchMedia('(min-width: 901px)').addEventListener('change', event => { if (event.matches) setNavigation(false); });
    let scheduled = false;
    new MutationObserver(() => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => { scheduled = false; syncWorkspace(); });
    }).observe(document.getElementById('chat'), { childList: true });
    [event_types.CHAT_CHANGED, event_types.CHAT_LOADED, event_types.CHARACTER_EDITED, event_types.CHARACTER_DELETED, event_types.CHARACTER_PAGE_LOADED, event_types.PERSONA_CHANGED].forEach(type => eventSource.on(type, syncWorkspace));
    eventSource.on(event_types.ONLINE_STATUS_CHANGED, syncConnection);
}

async function editCharacter(avatar) {
    const id = characters.findIndex(character => character.avatar === avatar);
    if (id < 0) return;
    await selectCharacterById(id);
    if (characters[this_chid]?.avatar !== avatar) return;
    document.querySelector(`[data-workspace-edit="${CSS.escape(avatar)}"]`)?.focus({ preventScroll: true });
    await openPanel('rightNavHolder');
    document.getElementById('description_textarea').focus();
}

async function startGroup(id) {
    if (selected_group === id || await openGroupById(id)) {
        setActiveGroup(id);
        saveSettingsDebounced();
        await navigateWorkspace('chat');
        document.getElementById('send_textarea').focus();
    }
}

async function initializeWorkspace() {
    if (document.getElementById('workspace-shell')) return;
    if (getCurrentLocale().startsWith('zh')) addLocaleData(getCurrentLocale(), chinese);
    createShell();
    initializeWorkspacePages({
        home: async () => {
            if (!await closeCurrentChat()) return false;
            await openWelcomeScreen({ force: true });
            document.getElementById('chat').scrollTop = 0;
            return true;
        },
        beforeNavigate: () => { closePanels(); setNavigation(false); },
    });
    document.documentElement.lang = getCurrentLocale();
    applyLocale(document);
    applyTheme(localStorage.getItem(themeStorageKey) === 'dark');
    bindEvents();
    syncWorkspace();
    await restoreWorkspacePage();
    if (!/Mac|iPhone|iPad/.test(navigator.platform)) {
        document.querySelectorAll('#workspace-shell kbd').forEach(label => label.textContent = label.textContent.replace('⌘', 'Ctrl'));
    }
}

eventSource.on(event_types.APP_READY, initializeWorkspace);
