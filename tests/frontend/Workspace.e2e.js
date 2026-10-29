import { test, expect } from '@playwright/test';
import { gunzipSync } from 'node:zlib';
import { testSetup } from './frontent-test-utils.js';

const routes = ['characters', 'worlds', 'personas', 'response', 'formatting', 'connections', 'extensions', 'backgrounds', 'settings'];

function savedScrollPreference(response, value) {
    const request = response.request();
    if (!response.url().endsWith('/api/settings/save') || request.method() !== 'POST') return false;
    const body = request.postDataBuffer();
    if (!body) return false;
    const decoded = request.headers()['content-encoding'] === 'gzip' ? gunzipSync(body) : body;
    return JSON.parse(decoded.toString()).power_user.auto_scroll_chat_to_bottom === value;
}

async function goTo(page, route) {
    if (await page.locator('#workspace-menu').isVisible()) await page.locator('#workspace-menu').click();
    await page.locator(`#workspace-sidebar .ws-nav-link[data-workspace-action="${route}"]`).click();
    await expect(page.locator(`#workspace-page-${route}`)).toBeVisible();
}

test.describe('Modern workspace user journeys', () => {
    test.describe.configure({ mode: 'default' });
    test.use({ locale: 'en-US', viewport: { width: 1440, height: 1000 } });

    test.beforeEach(async ({ page }) => {
        // Provider discovery is external; these journeys exercise an offline workspace.
        await page.route('**/api/horde/text-models', route => route.fulfill({ json: [] }));
        await page.route('**/api/horde/status', route => route.fulfill({ json: { ok: false } }));
        await testSetup.awaitST({ page });
        const onboarding = page.locator('dialog:has(.onboarding)');
        if (await onboarding.isVisible()) await onboarding.locator('.popup-button-ok').click();
        await page.locator('#workspace-sidebar').waitFor();
        await page.locator('#workspace-sidebar .ws-nav-link[data-workspace-action="home"]').click();
        await expect(page.locator('.welcomePanel')).toBeVisible();
    });

    test('navigation opens full main-area pages without a modal overlay', async ({ page }) => {
        for (const route of routes) {
            await goTo(page, route);
            await expect(page).toHaveURL(new RegExp(`#/${route}$`));
            await expect(page.locator('#sheld')).toBeHidden();
            await expect(page.locator('#workspace-panel-shade')).toBeHidden();
            await expect(page.locator('#workspace-sidebar [aria-current="page"]')).toHaveAttribute('data-workspace-action', route);
            const bounds = await page.locator(`#workspace-page-${route}`).boundingBox();
            expect(bounds.width).toBeGreaterThan(1000);
            await expect(page.locator(`#workspace-page-${route} [aria-modal="true"]`)).toHaveCount(0);
            await expect(page.locator(`#workspace-page-${route} .ws-panel-heading`)).toHaveCount(0);
            await page.keyboard.press('Escape');
            await expect(page.locator(`#workspace-page-${route}`)).toBeVisible();
        }
    });

    test('browser history and reload restore the selected page', async ({ page }) => {
        await goTo(page, 'characters');
        await goTo(page, 'settings');
        await page.goBack();
        await expect(page.locator('#workspace-page-characters')).toBeVisible();
        await page.goForward();
        await expect(page.locator('#workspace-page-settings')).toBeVisible();
        await page.reload();
        await page.locator('#workspace-sidebar').waitFor();
        await expect(page.locator('#workspace-page-settings')).toBeVisible();
        await expect(page.locator('#workspace-sidebar [aria-current="page"]')).toHaveAttribute('data-workspace-action', 'settings');
    });

    test('the character library searches and filters real character data', async ({ page }) => {
        await goTo(page, 'characters');
        await expect(page.locator('.ws-library-card').first()).toBeVisible();
        const name = await page.locator('.ws-library-card h2').first().innerText();
        const search = page.locator('#workspace-library-search');
        await search.fill('no-character-with-this-name-123456');
        await expect(page.locator('.ws-library-empty')).toBeVisible();
        await search.fill(name);
        await expect(page.locator('.ws-library-card h2').first()).toHaveText(name);
        await page.locator('[data-library-filter="groups"]').click();
        await expect(page.locator('[data-library-filter="groups"]')).toHaveAttribute('aria-pressed', 'true');
        await page.locator('[data-library-filter="all"]').click();
        await page.locator('#workspace-library-sort').selectOption('recent');
        await expect(page.locator('.ws-library-card').first()).toBeVisible();
    });

    test('global search handles empty results and opens a real conversation', async ({ page }) => {
        const name = await page.locator('.ws-character-card .ws-character-copy > strong').first().innerText();
        await goTo(page, 'settings');
        await page.keyboard.press('Control+k');
        const input = page.locator('#workspace-search-input');
        await expect(input).toBeFocused();
        await input.fill('no-character-with-this-name-123456');
        await expect(page.locator('.ws-search-empty')).toBeVisible();
        await input.fill(name);
        await page.keyboard.press('Enter');
        await expect(page.locator('#workspace-search')).toBeHidden();
        await expect(page.locator('#chat .mes').first()).toBeVisible();
        await expect(page.locator('#workspace-chat-name')).toHaveText(name);
        await expect(page).toHaveURL(/#\/chat$/);
    });

    test('management pages preserve the current conversation and input draft', async ({ page }) => {
        await page.locator('.ws-character-card').first().click();
        await expect(page.locator('#chat .mes').first()).toBeVisible();
        const message = await page.locator('#chat .mes .mes_text').first().innerText();
        const name = await page.locator('#workspace-chat-name').innerText();
        await page.locator('#send_textarea').fill('A draft to keep while checking settings.');
        for (const route of ['settings', 'characters', 'worlds']) await goTo(page, route);
        await page.locator('#workspace-resume-chat').click();
        await expect(page.locator('#workspace-chat-name')).toHaveText(name);
        await expect(page.locator('#send_textarea')).toHaveValue('A draft to keep while checking settings.');
        await expect(page.locator('#chat .mes .mes_text').first()).toHaveText(message, { useInnerText: true });
        await page.locator('#send_textarea').fill('');
    });

    test('a temporary chat opens the native composer and can return home', async ({ page }) => {
        await page.locator('.ws-quick-action[data-workspace-action="assistant"]').click();
        await expect(page.locator('.welcomePanel')).toHaveCount(0);
        await expect(page.locator('#send_textarea')).toBeVisible();
        await expect(page.locator('#send_textarea')).toBeFocused();
        await page.locator('#workspace-chat-header [data-workspace-action="home"]').click();
        await expect(page.locator('.welcomePanel')).toBeVisible();
        await expect(page).toHaveURL(/#\/home$/);
    });

    test('color preference and the selected page survive a reload', async ({ page }) => {
        await goTo(page, 'characters');
        await page.locator('.ws-theme-toggle').click();
        await expect(page.locator('body')).toHaveClass(/ws-dark/);
        await page.reload();
        await page.locator('#workspace-sidebar').waitFor();
        await expect(page.locator('.ws-theme-toggle')).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('#workspace-page-characters')).toBeVisible();
        await page.locator('.ws-theme-toggle').click();
        await expect(page.locator('body')).not.toHaveClass(/ws-dark/);
    });

    test('creation and import remain temporary workflows over the library', async ({ page }) => {
        await goTo(page, 'characters');
        await page.locator('.ws-page-actions [data-workspace-action="create"]').click();
        await expect(page.locator('#character_name_pole')).toBeVisible();
        await expect(page.locator('#character_name_pole')).toBeFocused();
        await expect(page.locator('#workspace-page-characters')).toBeVisible();
        await page.keyboard.press('Escape');
        const chooserPromise = page.waitForEvent('filechooser');
        await page.locator('.ws-page-actions [data-workspace-action="import"]').click();
        const chooser = await chooserPromise;
        expect(chooser.isMultiple()).toBe(true);
        await page.keyboard.press('Escape');
        await expect(page).toHaveURL(/#\/characters$/);
    });

    test('quick editing dismisses back to the same library page', async ({ page }) => {
        await goTo(page, 'characters');
        await page.locator('[data-workspace-edit]').first().click();
        await expect(page.locator('#description_textarea')).toBeVisible();
        await expect(page.locator('#workspace-panel-shade')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.locator('#workspace-panel-shade')).toBeHidden();
        await expect(page.locator('#workspace-page-characters')).toBeVisible();
        await expect(page).toHaveURL(/#\/characters$/);
    });

    test('the workspace follows the existing Chinese language preference', async ({ page }) => {
        await goTo(page, 'characters');
        await page.evaluate(() => localStorage.setItem('language', 'zh-cn'));
        await page.reload();
        await page.locator('#workspace-sidebar').waitFor();
        await expect(page.locator('#workspace-heading-characters')).toHaveText('角色库');
        await expect(page.locator('#workspace-library-search')).toHaveAttribute('placeholder', '搜索角色名称或标签…');
        await expect(page.locator('html')).toHaveAttribute('lang', 'zh-cn');
    });

    test('extensions can be filtered without losing their native settings', async ({ page }) => {
        await goTo(page, 'extensions');
        const search = page.locator('#workspace-extension-search');
        await search.fill('no-extension-with-this-name-123456');
        await expect(page.locator('#workspace-extension-empty')).toBeVisible();
        await search.fill('TTS');
        await expect(page.locator('#tts_container')).toBeVisible();
        await search.fill('');
        await expect(page.locator('#workspace-extension-empty')).toBeHidden();
        await expect(page.locator('#assets_container')).toBeVisible();
    });

    test('native settings still save after being moved into a page', async ({ page }) => {
        await goTo(page, 'settings');
        const checkbox = page.locator('#auto_scroll_chat_to_bottom');
        const original = await checkbox.isChecked();
        const saved = page.waitForResponse(response => savedScrollPreference(response, !original));
        await checkbox.setChecked(!original);
        expect((await saved).ok()).toBe(true);
        await page.reload();
        await page.locator('#workspace-sidebar').waitFor();
        await expect(checkbox).toBeVisible();
        await expect.poll(() => checkbox.isChecked()).toBe(!original);
        const restored = page.waitForResponse(response => savedScrollPreference(response, original));
        await checkbox.setChecked(original);
        expect((await restored).ok()).toBe(true);
    });

    test('lorebooks can be created and edited in the main page', async ({ page }) => {
        const book = `Workspace page test ${Date.now()}`;
        await goTo(page, 'worlds');
        try {
            await page.locator('.ws-page-actions [data-workspace-action="create-world"]').click();
            await page.locator('dialog[open] .popup-input').fill(book);
            await page.locator('dialog[open] .popup-button-ok').click();
            await expect(page.locator('#world_editor_select option:checked')).toHaveText(book);
            await expect(page.locator('#world_popup')).toHaveAttribute('aria-busy', 'false');
            await page.locator('#world_popup_new').click();
            await page.locator('#world_popup_entries_list .world_entry').first().waitFor();
            await page.locator('#OpenAllWIEntries').click();
            const content = page.locator('#world_popup_entries_list textarea[name="content"]').first();
            await expect(content).toBeVisible();
            const saved = page.waitForResponse(response => response.url().endsWith('/api/worldinfo/edit') && response.request().method() === 'POST');
            await content.fill('The observatory stands above a quiet mountain lake.');
            expect((await saved).ok()).toBe(true);
            await page.reload();
            await page.locator('#workspace-sidebar').waitFor();
            await page.locator('#world_editor_select').selectOption({ label: book });
            await page.locator('#OpenAllWIEntries').click();
            await expect(content).toHaveValue('The observatory stands above a quiet mountain lake.');
            await expect(page.locator('#workspace-page-worlds')).toBeVisible();
            await expect(page.locator('#workspace-panel-shade')).toBeHidden();
        } finally {
            await page.evaluate(async name => {
                const { deleteWorldInfo } = await import('./scripts/world-info.js');
                await deleteWorldInfo(name);
            }, book);
        }
    });

    test('all mobile pages scroll in the main canvas without horizontal overflow', async ({ page }) => {
        for (const width of [390, 320]) {
            await page.setViewportSize({ width, height: 844 });
            for (const route of routes) {
                await goTo(page, route);
                await expect(page.locator('#workspace-menu')).toHaveAttribute('aria-expanded', 'false');
                await expect(page.locator('#workspace-panel-shade')).toBeHidden();
                const bounds = await page.locator('#workspace-pages').boundingBox();
                expect(bounds.height).toBeGreaterThan(700);
                const sizes = await page.evaluate(() => ({ document:document.documentElement.scrollWidth, width:innerWidth, canvas:document.getElementById('workspace-pages').clientWidth, content:document.getElementById('workspace-pages').scrollWidth }));
                expect(sizes.document).toBe(sizes.width);
                expect(sizes.content, `${width}px ${route}`).toBeLessThanOrEqual(sizes.canvas);
            }
        }
    });
});
