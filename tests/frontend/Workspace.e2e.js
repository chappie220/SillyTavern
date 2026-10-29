import { test, expect } from '@playwright/test';
import { testSetup } from './frontent-test-utils.js';

test.describe('Modern workspace user journeys', () => {
    test.describe.configure({ mode: 'serial' });
    test.use({ locale: 'en-US', viewport: { width: 1440, height: 1000 } });

    test.beforeEach(async ({ page }) => {
        await testSetup.awaitST({ page });
        // Complete the existing first-run dialog if this is a fresh test data root.
        const onboarding = page.locator('dialog:has(.onboarding)');
        if (await onboarding.isVisible()) await onboarding.locator('.popup-button-ok').click();
        await page.locator('#workspace-sidebar').waitFor();
        await page.locator('#workspace-sidebar .ws-nav-link[data-workspace-action="home"]').click();
        await expect(page.locator('.welcomePanel')).toBeVisible();
    });

    test('all existing tools can be opened and dismissed with the keyboard', async ({ page }) => {
        for (const [action, panel] of [
            ['characters', 'right-nav-panel'], ['connections', 'rm_api_block'],
            ['worlds', 'WorldInfo'], ['personas', 'PersonaManagement'],
            ['response', 'left-nav-panel'], ['formatting', 'AdvancedFormatting'],
            ['extensions', 'rm_extensions_block'], ['backgrounds', 'Backgrounds'],
        ]) {
            await page.locator(`#workspace-sidebar .ws-nav-link[data-workspace-action="${action}"]`).click();
            const drawer = page.locator('#top-settings-holder .openDrawer');
            await expect(drawer).toHaveCount(1);
            await expect(drawer).toHaveAttribute('id', panel);
            const bounds = await drawer.boundingBox();
            expect(bounds.x).toBeGreaterThanOrEqual(0);
            expect(bounds.x + bounds.width).toBeLessThanOrEqual(1440);
            expect(bounds.y + bounds.height).toBeLessThanOrEqual(1000);
            await page.keyboard.press('Escape');
            await expect(drawer).toHaveCount(0);
        }
    });

    test('search handles empty results and opens a real character conversation', async ({ page }) => {
        const character = page.locator('.ws-character-card').first();
        await expect(character).toBeVisible();
        const name = await character.locator('.ws-character-copy > strong').innerText();
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
        await expect(page.locator('#send_textarea')).toBeVisible();
        await page.locator('#workspace-chat-header [data-workspace-action="home"]').click();
        await expect(page.locator('.welcomePanel')).toBeVisible();
    });

    test('a temporary chat opens the native composer and can return home', async ({ page }) => {
        await page.locator('.ws-quick-action[data-workspace-action="assistant"]').click();
        await expect(page.locator('.welcomePanel')).toHaveCount(0);
        await expect(page.locator('#send_textarea')).toBeVisible();
        await expect(page.locator('#send_textarea')).toBeFocused();
        await expect(page.locator('#workspace-composer-status')).toBeVisible();
        await page.locator('#workspace-chat-header [data-workspace-action="home"]').click();
        await expect(page.locator('.welcomePanel')).toBeVisible();
    });

    test('color preference survives a reload', async ({ page }) => {
        const toggle = page.locator('.ws-theme-toggle');
        await toggle.click();
        await expect(page.locator('body')).toHaveClass(/ws-dark/);
        await page.reload();
        await expect(page.locator('.ws-theme-toggle')).toHaveAttribute('aria-pressed', 'true');
        await page.locator('.ws-theme-toggle').click();
        await expect(page.locator('body')).not.toHaveClass(/ws-dark/);
    });

    test('creation and import launch the existing character workflows', async ({ page }) => {
        await page.locator('.ws-quick-action[data-workspace-action="create"]').click();
        await expect(page.locator('#character_name_pole')).toBeVisible();
        await expect(page.locator('#character_name_pole')).toBeFocused();
        await page.keyboard.press('Escape');
        const chooserPromise = page.waitForEvent('filechooser');
        await page.locator('.ws-import-card').click();
        const chooser = await chooserPromise;
        expect(chooser.isMultiple()).toBe(true);
        await page.keyboard.press('Escape');
    });

    test('the new workspace follows the existing Chinese language preference', async ({ page }) => {
        await page.evaluate(() => localStorage.setItem('language', 'zh-cn'));
        await page.reload();
        await page.locator('#workspace-sidebar').waitFor();
        await expect(page.locator('#workspace-sidebar .ws-nav-link[data-workspace-action="home"]')).toHaveText('首页');
        await expect(page.locator('.ws-story h2')).toHaveText('下一段对话，会带你去哪里？');
        await expect(page.locator('html')).toHaveAttribute('lang', 'zh-cn');
    });

    test('mobile navigation and connection panel stay within the viewport', async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(page.locator('#workspace-sidebar')).toBeHidden();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
        const canvas = await page.locator('#sheld').boundingBox();
        expect(canvas.height).toBeGreaterThan(700);
        await expect(page.locator('.ws-greeting')).toBeVisible();
        await page.locator('#workspace-menu').click();
        await expect(page.locator('#workspace-sidebar')).toBeVisible();
        await expect(page.locator('#workspace-menu')).toHaveAttribute('aria-expanded', 'true');
        await page.locator('#workspace-sidebar .ws-nav-link[data-workspace-action="connections"]').click();
        await expect(page.locator('#workspace-menu')).toHaveAttribute('aria-expanded', 'false');
        const panel = page.locator('#rm_api_block');
        await expect(panel).toBeVisible();
        const bounds = await panel.boundingBox();
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(844);
        await panel.locator('.ws-panel-heading button').click();
        await expect(panel).toBeHidden();
    });
});
