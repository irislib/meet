import { test, expect } from '@playwright/test';
import { setupPageErrorHandler, loginAnonymously } from './test-utils';

test.describe('Meeting Creation', () => {
  test.beforeEach(async ({ page }) => {
    setupPageErrorHandler(page);
    await page.goto('/');
    await loginAnonymously(page);
  });

  test('can start a new meeting', async ({ page }) => {
    // Click Start Meeting
    await page.getByRole('button', { name: 'Start Meeting' }).click();

    // Should go directly to meeting room - check for leave button
    await expect(page.getByTitle('Leave meeting')).toBeVisible({ timeout: 15000 });
  });

  test('meeting room has controls', async ({ page }) => {
    // Start a meeting
    await page.getByRole('button', { name: 'Start Meeting' }).click();
    await expect(page.getByTitle('Leave meeting')).toBeVisible({ timeout: 15000 });

    // Should have microphone toggle (starts OFF)
    await expect(page.getByTitle(/Unmute microphone/i)).toBeVisible();

    // Should have camera toggle (starts OFF)
    await expect(page.getByTitle(/Turn on camera/i)).toBeVisible();

    // Should have screen share button
    await expect(page.getByTitle('Share screen')).toBeVisible();
  });

  test('can copy meeting link from meeting room', async ({ page }) => {
    // Start a meeting
    await page.getByRole('button', { name: 'Start Meeting' }).click();
    await expect(page.getByTitle('Leave meeting')).toBeVisible({ timeout: 15000 });

    // Click Copy Link button in controls
    const copyButton = page.getByTitle('Copy meeting link');
    await expect(copyButton).toBeVisible();
    await copyButton.click();
  });

  test('can leave meeting', async ({ page }) => {
    // Start a meeting
    await page.getByRole('button', { name: 'Start Meeting' }).click();
    await expect(page.getByTitle('Leave meeting')).toBeVisible({ timeout: 15000 });

    // Click leave
    await page.getByTitle('Leave meeting').click();

    // Should be back at home screen
    await expect(page.getByRole('heading', { name: 'Start a Meeting' })).toBeVisible({ timeout: 10000 });
  });

  test('can toggle microphone', async ({ page }) => {
    // Start a meeting
    await page.getByRole('button', { name: 'Start Meeting' }).click();
    await expect(page.getByTitle('Leave meeting')).toBeVisible({ timeout: 15000 });

    // Initially microphone should be disabled (muted)
    const micButton = page.getByTitle('Unmute microphone');
    await expect(micButton).toBeVisible();

    // Click to unmute (this will request permissions)
    await micButton.click();

    // Should now show mute option
    await expect(page.getByTitle('Mute microphone')).toBeVisible();
  });

  test('can toggle camera', async ({ page }) => {
    // Start a meeting
    await page.getByRole('button', { name: 'Start Meeting' }).click();
    await expect(page.getByTitle('Leave meeting')).toBeVisible({ timeout: 15000 });

    // Initially camera should be disabled
    const cameraButton = page.getByTitle('Turn on camera');
    await expect(cameraButton).toBeVisible();

    // Click to turn on (this will request permissions)
    await cameraButton.click();

    // Should now show turn off option
    await expect(page.getByTitle('Turn off camera')).toBeVisible();
  });
});

test.describe('Meeting Join', () => {
  test.beforeEach(async ({ page }) => {
    setupPageErrorHandler(page);
    await page.goto('/');
    await loginAnonymously(page);
  });

  test('shows join meeting form', async ({ page }) => {
    // Should show join meeting section
    await expect(page.getByRole('heading', { name: 'Join a Meeting' })).toBeVisible();

    // Should have input for meeting link
    await expect(page.getByPlaceholder('Paste meeting link')).toBeVisible();

    // Should have join button (disabled initially)
    const joinButton = page.getByRole('button', { name: 'Join Meeting' });
    await expect(joinButton).toBeVisible();
    await expect(joinButton).toBeDisabled();
  });

  test('join button enables when link is entered', async ({ page }) => {
    const input = page.getByPlaceholder('Paste meeting link');
    const joinButton = page.getByRole('button', { name: 'Join Meeting' });

    // Initially disabled
    await expect(joinButton).toBeDisabled();

    // Enter a valid hex key (64 chars)
    await input.fill('0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');

    // Should be enabled now
    await expect(joinButton).toBeEnabled();
  });

  test('shows error for invalid meeting link', async ({ page }) => {
    const input = page.getByPlaceholder('Paste meeting link');
    const joinButton = page.getByRole('button', { name: 'Join Meeting' });

    // Enter invalid text
    await input.fill('invalid-link');
    await joinButton.click();

    // Should show error
    await expect(page.getByText(/valid meeting link/i)).toBeVisible();
  });
});
