import { test, expect, Browser, Page } from '@playwright/test';
import { setupPageErrorHandler } from './test-utils';

test.describe('Multi-user Meeting', () => {
  test('two users can join the same meeting', async ({ browser }) => {
    // Create two browser contexts (simulating two different users)
    const context1 = await browser.newContext({
      permissions: ['camera', 'microphone'],
    });
    const context2 = await browser.newContext({
      permissions: ['camera', 'microphone'],
    });

    const page1 = await context1.newPage();
    const page2 = await context2.newPage();

    setupPageErrorHandler(page1);
    setupPageErrorHandler(page2);

    // User 1: Login and create a meeting
    await page1.goto('/');
    await page1.getByRole('button', { name: 'Join' }).click();
    await expect(page1.getByRole('heading', { name: 'Start a Meeting' })).toBeVisible({ timeout: 15000 });

    // Create meeting
    await page1.getByRole('button', { name: 'Start Meeting' }).click();
    await expect(page1.getByTitle('Leave meeting')).toBeVisible({ timeout: 15000 });

    // Get the meeting URL
    const meetingUrl = page1.url();
    console.log('Meeting URL:', meetingUrl);

    // User 2: Login and join the same meeting via URL
    await page2.goto(meetingUrl);

    // User 2 should see "Join Meeting" button since there's a meeting in URL
    await page2.getByRole('button', { name: 'Join Meeting' }).click();
    await expect(page2.getByTitle('Leave meeting')).toBeVisible({ timeout: 15000 });

    // Verify WebRTC connection - both users should see each other's video tiles
    // Each user sees their own tile (with "You") plus the remote participant
    await expect(page1.getByText('(You)')).toBeVisible({ timeout: 15000 });
    await expect(page2.getByText('(You)')).toBeVisible({ timeout: 15000 });

    // Wait for peer connection to establish and verify remote participant appears
    // Each user should see 2 video tiles (their own + remote participant)
    await expect(page1.getByTestId('video-tile')).toHaveCount(2, { timeout: 15000 });
    await expect(page2.getByTestId('video-tile')).toHaveCount(2, { timeout: 15000 });

    // Clean up
    await context1.close();
    await context2.close();
  });

  test('user can leave meeting and return to home', async ({ browser }) => {
    const context1 = await browser.newContext({
      permissions: ['camera', 'microphone'],
    });

    const page1 = await context1.newPage();

    setupPageErrorHandler(page1);

    // User 1: Create meeting
    await page1.goto('/');
    await page1.getByRole('button', { name: 'Join' }).click();
    await expect(page1.getByRole('heading', { name: 'Start a Meeting' })).toBeVisible({ timeout: 15000 });
    await page1.getByRole('button', { name: 'Start Meeting' }).click();
    await expect(page1.getByTitle('Leave meeting')).toBeVisible({ timeout: 15000 });

    // User leaves
    await page1.getByTitle('Leave meeting').click();
    await expect(page1.getByRole('heading', { name: 'Start a Meeting' })).toBeVisible({ timeout: 10000 });

    await context1.close();
  });
});
