import { test, expect } from '@playwright/test';
import { setupPageErrorHandler } from './test-utils';

test.describe('Login Flow', () => {
  test.beforeEach(async ({ page }) => {
    setupPageErrorHandler(page);
  });

  test('shows login page on first visit', async ({ page }) => {
    await page.goto('/');

    // Should show the iris meet branding
    await expect(page.getByRole('heading', { name: 'iris meet' })).toBeVisible();

    // Should have name input
    await expect(page.getByPlaceholder('Name')).toBeVisible();

    // Should have Join button (no NIP-07 extension in tests)
    await expect(page.getByRole('button', { name: 'Join' })).toBeVisible();
  });

  test('can login without name', async ({ page }) => {
    await page.goto('/');

    // Click Join without entering a name
    await page.getByRole('button', { name: 'Join' }).click();

    // Should navigate to home screen
    await expect(page.getByRole('heading', { name: 'Start a Meeting' })).toBeVisible({ timeout: 15000 });
    await expect(page.getByRole('heading', { name: 'Join a Meeting' })).toBeVisible();
  });

  test('can login with custom name', async ({ page }) => {
    await page.goto('/');

    // Enter a custom name
    await page.getByPlaceholder('Name').fill('Test User');

    // Click Join
    await page.getByRole('button', { name: 'Join' }).click();

    // Should navigate to home screen
    await expect(page.getByRole('heading', { name: 'Start a Meeting' })).toBeVisible({ timeout: 15000 });
  });

  test('persists login across page reload', async ({ page }) => {
    await page.goto('/');

    // Login
    await page.getByRole('button', { name: 'Join' }).click();
    await expect(page.getByRole('heading', { name: 'Start a Meeting' })).toBeVisible({ timeout: 15000 });

    // Reload the page
    await page.reload();

    // Should still be logged in (not showing login form)
    await expect(page.getByRole('heading', { name: 'Start a Meeting' })).toBeVisible({ timeout: 15000 });
  });

  test('custom name persists across page reload', async ({ page }) => {
    await page.goto('/');

    // Login with custom name
    await page.getByPlaceholder('Name').fill('Persistent User');
    await page.getByRole('button', { name: 'Join' }).click();
    await expect(page.getByRole('heading', { name: 'Start a Meeting' })).toBeVisible({ timeout: 15000 });

    // Name should be visible in header
    await expect(page.getByText('Persistent User')).toBeVisible();

    // Reload the page
    await page.reload();

    // Name should still be visible after reload
    await expect(page.getByRole('heading', { name: 'Start a Meeting' })).toBeVisible({ timeout: 15000 });
    await expect(page.getByText('Persistent User')).toBeVisible();
  });

  test('can logout', async ({ page }) => {
    await page.goto('/');

    // Login
    await page.getByRole('button', { name: 'Join' }).click();
    await expect(page.getByRole('heading', { name: 'Start a Meeting' })).toBeVisible({ timeout: 15000 });

    // Click user menu to open dropdown
    await page.locator('.i-carbon-chevron-down').click();

    // Click logout in dropdown
    await page.getByRole('button', { name: 'Logout' }).click();

    // Should be back at login screen
    await expect(page.getByRole('heading', { name: 'iris meet' })).toBeVisible();
  });
});
