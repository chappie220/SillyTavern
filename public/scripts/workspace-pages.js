import { characters, event_types, eventSource, getCurrentChatId, name2 } from '../script.js';
import { groups, selected_group } from './group-chats.js';
import { t } from './i18n.js';

const pages = {
    characters: { title: 'Character library', description: 'Find a familiar voice or give someone new a story.', icon: 'address-card' },
    worlds: { title: 'World info', description: 'Write the places, history, and details your characters should remember.', icon: 'book-open', drawer: 'WI-SP-button' },
    personas: { title: 'Personas', description: 'Choose who you are in each conversation.', icon: 'user', drawer: 'persona-management-button' },
    response: { title: 'Response settings', description: 'Shape how your model writes and responds.', icon: 'sliders', drawer: 'ai-config-button' },
    formatting: { title: 'Prompt format', description: 'Configure the context and instructions sent to your model.', icon: 'font', drawer: 'advanced-formatting-button' },
    connections: { title: 'Model connections', description: 'Connect a model and manage your connection profiles.', icon: 'plug', drawer: 'sys-settings-button' },
    extensions: { title: 'Extensions', description: 'Add new abilities and configure the tools in your workspace.', icon: 'shapes', drawer: 'extensions-settings-button' },
    backgrounds: { title: 'Appearance', description: 'Choose the backdrop for your conversations.', icon: 'image', drawer: 'backgrounds-button' },
    settings: { title: 'Settings', description: 'Make the workspace feel right for you.', icon: 'gear', drawer: 'user-settings-button' },
};

let activeRoute = 'home';
let callbacks;
let host;
let transitionId = 0;
let libraryFilter = 'all';
let librarySignature = '';
const scrollPositions = new Map();

function escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[char]));
}

function icon(name) {
    return `<i class="fa-solid fa-${name}" aria-hidden="true"></i>`;
}

function plainText(value) {
    return new DOMParser().parseFromString(String(value || ''), 'text/html').body.textContent.replace(/\s+/g, ' ').trim();
}

function isFavorite(entry) {
    return [entry.fav, entry.data?.extensions?.fav].some(value => value === true || value === 'true');
}

function pageActions(route) {
    if (route === 'characters') {
        return `<button type="button" class="ws-button ws-secondary" data-workspace-action="import">${icon('file-import')}${escape(t`Import a character`)}</button><button type="button" class="ws-button ws-primary" data-workspace-action="create">${icon('plus')}${escape(t`Create a character`)}</button>`;
    }
    if (route === 'worlds') {
        return `<button type="button" class="ws-button ws-secondary" data-workspace-action="import-world">${icon('file-import')}${escape(t`Import`)}</button><button type="button" class="ws-button ws-primary" data-workspace-action="create-world">${icon('plus')}${escape(t`Create lorebook`)}</button>`;
    }
    return '';
}

function createLibrary() {
    return `<div class="ws-library-toolbar">
        <label class="ws-library-search">${icon('magnifying-glass')}<span class="ws-sr-only">${escape(t`Search characters`)}</span><input id="workspace-library-search" type="search" placeholder="${escape(t`Search by name or tag…`)}" autocomplete="off"></label>
        <label class="ws-library-sort"><span>${escape(t`Sort by`)}</span><select id="workspace-library-sort"><option value="name">${escape(t`Name`)}</option><option value="recent">${escape(t`Recent`)}</option></select></label>
        <button type="button" class="ws-icon-button" data-workspace-action="character-tools" aria-label="${escape(t`More character tools`)}" title="${escape(t`More character tools`)}">${icon('ellipsis')}</button>
    </div>
    <div class="ws-library-filter-row"><div class="ws-library-filters" role="group" aria-label="${escape(t`Filter characters`)}">
        <button type="button" data-library-filter="all" aria-pressed="true">${escape(t`All characters`)}</button>
        <button type="button" data-library-filter="favorites" aria-pressed="false">${icon('star')}${escape(t`Favorites`)}</button>
        <button type="button" data-library-filter="groups" aria-pressed="false">${icon('users')}${escape(t`Groups`)}</button>
    </div><span id="workspace-library-count" aria-live="polite"></span></div>
    <div id="workspace-library-grid" class="ws-library-grid"></div>`;
}

function createPage(route, definition) {
    const section = document.createElement('section');
    section.id = `workspace-page-${route}`;
    section.className = `ws-page ws-route-${route}`;
    section.hidden = true;
    section.setAttribute('aria-labelledby', `workspace-heading-${route}`);
    section.innerHTML = `<header class="ws-page-heading"><div><h1 id="workspace-heading-${route}" tabindex="-1">${escape(t([definition.title]))}</h1><p>${escape(t([definition.description]))}</p></div><div class="ws-page-actions">${pageActions(route)}</div></header><div class="ws-page-body"></div>`;
    const body = section.querySelector('.ws-page-body');
    if (route === 'characters') {
        body.innerHTML = createLibrary();
    } else {
        const drawer = document.getElementById(definition.drawer);
        const panel = drawer.querySelector('.drawer-content');
        drawer.classList.add('ws-page-widget');
        drawer.dataset.workspaceRoute = route;
        panel.classList.add('ws-page-panel');
        panel.classList.remove('openDrawer', 'pinnedOpen');
        panel.classList.add('closedDrawer');
        panel.querySelector('.ws-panel-heading')?.remove();
        panel.setAttribute('role', 'region');
        panel.setAttribute('aria-labelledby', `workspace-heading-${route}`);
        panel.removeAttribute('aria-modal');
        body.append(drawer);
        if (route === 'worlds') {
            const empty = document.createElement('div');
            empty.className = 'ws-world-empty';
            empty.id = 'workspace-world-empty';
            empty.innerHTML = `${icon('book-open')}<h2>${escape(t`Every world starts with a detail`)}</h2><p>${escape(t`Create a lorebook or choose one above to start writing.`)}</p><button type="button" class="ws-button ws-secondary" data-workspace-action="create-world">${icon('plus')}${escape(t`Create lorebook`)}</button>`;
            panel.append(empty);
        }
    }
    if (route === 'connections') {
        const help = document.createElement('aside');
        help.className = 'ws-connection-help';
        help.innerHTML = `<span class="ws-action-icon ws-iris">${icon('plug')}</span><h2>${escape(t`Bring your own model`)}</h2><p>${escape(t`Choose your provider, enter its connection details, then select a model. You can save different setups as connection profiles.`)}</p><a href="https://docs.sillytavern.app/usage/api-connections/" target="_blank" rel="noopener noreferrer">${escape(t`Connection guide`)}${icon('arrow-up-right-from-square')}</a>`;
        body.append(help);
    }
    if (route === 'extensions') {
        const title = body.querySelector('h3[data-i18n="Extensions"]');
        if (title) {
            title.dataset.i18n = 'Installed extensions';
            title.textContent = t`Installed extensions`;
        }
        const search = document.createElement('label');
        search.className = 'ws-extension-search ws-library-search';
        search.innerHTML = `${icon('magnifying-glass')}<span class="ws-sr-only">${escape(t`Search extensions`)}</span><input id="workspace-extension-search" type="search" placeholder="${escape(t`Search extensions`)}" autocomplete="off">`;
        body.prepend(search);
        const empty = document.createElement('p');
        empty.className = 'ws-extension-empty';
        empty.id = 'workspace-extension-empty';
        empty.hidden = true;
        empty.textContent = t`No matching extensions`;
        body.append(empty);
    }
    return section;
}

/** Keep native controls and event handlers in a normal page document flow. */
export function initializeWorkspacePages(handlers) {
    callbacks = handlers;
    host = document.createElement('main');
    host.id = 'workspace-pages';
    host.hidden = true;
    for (const [route, definition] of Object.entries(pages)) host.append(createPage(route, definition));
    document.body.append(host);
    const resume = document.createElement('button');
    resume.type = 'button';
    resume.id = 'workspace-resume-chat';
    resume.className = 'ws-text-button';
    resume.dataset.workspaceAction = 'resume-chat';
    resume.innerHTML = `${icon('arrow-left')}<span>${escape(t`Back to chat`)}</span>`;
    document.querySelector('.ws-header-start').append(resume);
    document.getElementById('workspace-library-search').addEventListener('input', renderLibrary);
    document.getElementById('workspace-library-sort').addEventListener('change', renderLibrary);
    document.getElementById('workspace-extension-search').addEventListener('input', filterExtensions);
    $('#world_editor_select').on('change.workspacePages', () => {
        syncWorldEmpty();
        setWorldEditorBusy(document.getElementById('world_editor_select').value !== '');
    });
    eventSource.on(event_types.WORLDINFO_EDITOR_LOADED, ({ name }) => {
        if (document.querySelector('#world_editor_select option:checked')?.textContent === name) setWorldEditorBusy(false);
    });
    host.addEventListener('click', event => {
        const filter = event.target.closest('[data-library-filter]');
        if (filter) {
            libraryFilter = filter.dataset.libraryFilter;
            renderLibrary();
        }
        if (event.target.closest('[data-library-clear]')) {
            libraryFilter = 'all';
            document.getElementById('workspace-library-search').value = '';
            renderLibrary();
            document.getElementById('workspace-library-search').focus();
        }
    });
    addEventListener('hashchange', () => {
        void navigateWorkspace(routeFromLocation(), { updateHistory: false });
    });
    document.addEventListener('workspace:navigate', event => {
        void navigateWorkspace(event.detail.route, { focus: false });
    });
    [event_types.GROUP_UPDATED, event_types.CHARACTER_DUPLICATED, event_types.CHARACTER_RENAMED].forEach(type => eventSource.on(type, renderLibrary));
}

function routeFromLocation() {
    const route = location.hash.replace(/^#\/?/, '').split(/[/?]/)[0];
    return route === 'home' || route === 'chat' || Object.hasOwn(pages, route) ? route : getCurrentChatId() === undefined ? 'home' : 'chat';
}

export async function restoreWorkspacePage() {
    return navigateWorkspace(routeFromLocation(), { replace: true, focus: false });
}

export function isWorkspacePage(route) {
    return Object.hasOwn(pages, route);
}

/** Switching pages hides the chat DOM without clearing messages or drafts. */
export async function navigateWorkspace(route, { updateHistory = true, replace = false, focus = true } = {}) {
    if (!host) return false;
    if (!Object.hasOwn(pages, route) && route !== 'home' && route !== 'chat') route = 'home';
    const transition = ++transitionId;
    if (route === 'home' && !document.querySelector('#chat .welcomePanel')) {
        if (!await callbacks.home()) return false;
        if (transition !== transitionId) return false;
    }
    if (route === 'chat' && document.querySelector('#chat .welcomePanel')) route = 'home';
    callbacks.beforeNavigate();
    scrollPositions.set(activeRoute, host.scrollTop);
    activeRoute = route;
    document.body.dataset.workspacePage = route;
    const isPage = Object.hasOwn(pages, route);
    document.getElementById('sheld').hidden = isPage;
    host.hidden = !isPage;
    for (const [name, definition] of Object.entries(pages)) {
        const section = document.getElementById(`workspace-page-${name}`);
        section.hidden = name !== route;
        if (!definition.drawer) continue;
        const panel = document.getElementById(definition.drawer).querySelector('.drawer-content');
        panel.classList.toggle('openDrawer', name === route);
        panel.classList.toggle('closedDrawer', name !== route);
        // Legacy drawer openers must not close the active main page when a quick editor opens.
        panel.classList.toggle('pinnedOpen', name === route);
    }
    if (updateHistory && location.hash !== `#/${route}`) {
        history[replace ? 'replaceState' : 'pushState']({ workspaceRoute: route }, '', `#/${route}`);
    }
    host.scrollTop = scrollPositions.get(route) || 0;
    syncWorkspacePages();
    if (route === 'extensions') filterExtensions();
    if (route === 'worlds') syncWorldEmpty();
    if (focus && isPage) document.getElementById(`workspace-heading-${route}`).focus({ preventScroll: true });
    if (focus && route === 'home') {
        const heading = document.querySelector('.ws-greeting h1');
        heading?.setAttribute('tabindex', '-1');
        heading?.focus({ preventScroll: true });
    }
    if (focus && route === 'chat') document.getElementById('send_textarea').focus({ preventScroll: true });
    return true;
}

export function syncWorkspacePages() {
    if (!host) return;
    const home = Boolean(document.querySelector('#chat .welcomePanel'));
    const title = pages[activeRoute] ? t([pages[activeRoute].title]) : home ? t`Home` : name2 || t`New chat`;
    document.getElementById('workspace-page-title').textContent = title;
    document.querySelectorAll('.ws-nav-link[data-workspace-action]').forEach(button => {
        const current = button.dataset.workspaceAction === activeRoute;
        button.classList.toggle('is-active', current);
        if (current) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
    });
    document.querySelector('.ws-profile').classList.toggle('is-active', activeRoute === 'settings');
    const resume = document.getElementById('workspace-resume-chat');
    resume.hidden = !pages[activeRoute];
    resume.querySelector('span').textContent = home ? t`Back to home` : t`Back to chat`;
    resume.dataset.workspaceAction = home ? 'home' : 'resume-chat';
    if (activeRoute === 'characters') renderLibrary();
}

function renderLibrary() {
    const target = document.getElementById('workspace-library-grid');
    if (!target) return;
    const query = document.getElementById('workspace-library-search').value.trim().toLocaleLowerCase();
    const sort = document.getElementById('workspace-library-sort').value;
    const source = libraryFilter === 'groups' ? groups : characters;
    const entries = source.filter(entry => {
        if (libraryFilter === 'favorites' && !isFavorite(entry)) return false;
        return `${entry.name} ${(entry.data?.tags || []).join(' ')}`.toLocaleLowerCase().includes(query);
    }).slice().sort((a, b) => {
        if (sort === 'recent') {
            const time = item => Number(item.date_last_chat) || Date.parse(item.date_last_chat) || 0;
            return time(b) - time(a) || a.name.localeCompare(b.name);
        }
        return a.name.localeCompare(b.name);
    });
    document.querySelectorAll('[data-library-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.libraryFilter === libraryFilter)));
    document.getElementById('workspace-library-count').textContent = libraryFilter === 'groups'
        ? entries.length === 1 ? t`${entries.length} group` : t`${entries.length} groups`
        : entries.length === 1 ? t`${entries.length} character` : t`${entries.length} characters`;
    const signature = JSON.stringify([libraryFilter, query, sort, entries.map(entry => [entry.avatar, entry.id, entry.name, entry.fav, entry.data?.extensions?.fav, entry.creatorcomment, entry.description, entry.data?.creator_notes, entry.data?.tags, entry.members, entry.id === selected_group])]);
    if (signature === librarySignature) return;
    librarySignature = signature;
    if (!entries.length) {
        const emptyTitle = libraryFilter === 'groups' ? t`No groups here yet` : libraryFilter === 'favorites' ? t`No favorite characters yet` : t`No matching characters`;
        const action = libraryFilter === 'groups' ? `<button type="button" class="ws-button ws-primary" data-workspace-action="create-group">${icon('plus')}${escape(t`Create a group`)}</button>` : `<button type="button" class="ws-button ws-secondary" data-library-clear>${escape(t`Show all characters`)}</button>`;
        target.innerHTML = `<div class="ws-library-empty">${icon(libraryFilter === 'groups' ? 'users' : 'address-card')}<h2>${escape(emptyTitle)}</h2><p>${escape(t`Try another search or add someone new to your collection.`)}</p>${action}</div>`;
        return;
    }
    target.innerHTML = entries.map(entry => {
        if (libraryFilter === 'groups') {
            return `<article class="ws-library-card ws-group-card"><div class="ws-library-portrait ws-group-portrait">${icon('users')}</div><div class="ws-library-card-copy"><h2>${escape(entry.name)}</h2><p>${escape(t`${entry.members?.length || 0} members`)}</p><button type="button" class="ws-button ws-secondary" data-workspace-group="${escape(entry.id)}">${icon('comments')}${escape(t`Start a chat`)}</button></div></article>`;
        }
        const description = plainText(entry.data?.creator_notes || entry.creatorcomment || entry.description);
        const favorite = isFavorite(entry);
        const tags = Array.isArray(entry.data?.tags) ? entry.data.tags.slice(0, 3) : [];
        return `<article class="ws-library-card"><div class="ws-library-portrait"><img src="characters/${encodeURIComponent(entry.avatar)}" alt="" width="280" height="190" loading="lazy">${favorite ? `<span class="ws-library-favorite" title="${escape(t`Favorite`)}">${icon('star')}</span>` : ''}</div><div class="ws-library-card-copy"><div class="ws-library-card-title"><h2>${escape(entry.name)}</h2><button type="button" class="ws-icon-button" data-workspace-edit="${escape(entry.avatar)}" aria-label="${escape(t`Edit character`)}: ${escape(entry.name)}">${icon('pen')}</button></div><p>${escape(description || t`Ready for a new conversation`)}</p><div class="ws-character-tags">${tags.map(tag => `<span>${escape(tag)}</span>`).join('')}</div><button type="button" class="ws-button ws-secondary" data-workspace-character="${escape(entry.avatar)}">${icon('comments')}${escape(t`Start a chat`)}</button></div></article>`;
    }).join('') + (libraryFilter === 'all' && !query ? `<button type="button" class="ws-library-add" data-workspace-action="create"><span class="ws-import-icon">${icon('plus')}</span><strong>${escape(t`Create a character`)}</strong><span>${escape(t`Give a new personality a voice`)}</span></button>` : '');
}

function filterExtensions() {
    const query = document.getElementById('workspace-extension-search').value.trim().toLocaleLowerCase();
    let count = 0;
    document.querySelectorAll('#rm_extensions_block .extension_container').forEach(container => {
        const matches = !query || container.textContent.toLocaleLowerCase().includes(query);
        container.hidden = !matches;
        if (matches && container.children.length) count++;
    });
    document.getElementById('workspace-extension-empty').hidden = !query || count > 0;
}

function syncWorldEmpty() {
    const empty = document.getElementById('workspace-world-empty');
    if (empty) empty.hidden = document.getElementById('world_editor_select').value !== '';
}

function setWorldEditorBusy(busy) {
    document.getElementById('world_popup').setAttribute('aria-busy', String(busy));
    for (const id of ['world_popup_new', 'world_popup_export', 'world_popup_name_button', 'world_duplicate', 'world_popup_delete']) {
        const control = document.getElementById(id);
        control.inert = busy;
        control.setAttribute('aria-disabled', String(busy));
    }
}
