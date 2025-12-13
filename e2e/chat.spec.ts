import { test, expect } from '@playwright/test';
import { setupPageErrorHandler } from './test-utils';

test.describe('Chat', () => {
  test('two users can send chat messages to each other', async ({ browser }) => {
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

    // User 2: Login and join the same meeting via URL
    await page2.goto(meetingUrl);
    await page2.getByRole('button', { name: 'Join Meeting' }).click();
    await expect(page2.getByTitle('Leave meeting')).toBeVisible({ timeout: 15000 });

    // Wait for WebRTC connection and data channels to establish
    await page1.waitForTimeout(3000);

    // User 1: Open chat and send a message
    await page1.getByTitle('Open chat').click();
    await expect(page1.getByText('No messages yet')).toBeVisible();
    await page1.getByPlaceholder('Type a message...').fill('Hello from User 1');
    await page1.getByPlaceholder('Type a message...').press('Enter');

    // User 1 should see their own message
    await expect(page1.getByText('Hello from User 1')).toBeVisible();

    // User 2: Open chat and wait for message (data channel may take a moment)
    await page2.getByTitle('Open chat').click();
    await expect(page2.getByText('Hello from User 1')).toBeVisible({ timeout: 15000 });

    // User 2: Send a reply
    await page2.getByPlaceholder('Type a message...').fill('Hello from User 2');
    await page2.getByPlaceholder('Type a message...').press('Enter');

    // Both users should see both messages
    await expect(page1.getByText('Hello from User 2')).toBeVisible({ timeout: 10000 });
    await expect(page2.getByText('Hello from User 2')).toBeVisible();

    // Clean up
    await context1.close();
    await context2.close();
  });

  test('chat can be opened and closed', async ({ browser }) => {
    const context1 = await browser.newContext({
      permissions: ['camera', 'microphone'],
    });

    const page1 = await context1.newPage();
    setupPageErrorHandler(page1);

    // Login and create meeting
    await page1.goto('/');
    await page1.getByRole('button', { name: 'Join' }).click();
    await expect(page1.getByRole('heading', { name: 'Start a Meeting' })).toBeVisible({ timeout: 15000 });
    await page1.getByRole('button', { name: 'Start Meeting' }).click();
    await expect(page1.getByTitle('Leave meeting')).toBeVisible({ timeout: 15000 });

    // Chat should not be visible initially
    await expect(page1.getByText('No messages yet')).not.toBeVisible();

    // Open chat
    await page1.getByTitle('Open chat').click();
    await expect(page1.getByText('No messages yet')).toBeVisible();

    // Close chat
    await page1.getByTitle('Close chat').click();
    await expect(page1.getByText('No messages yet')).not.toBeVisible();

    await context1.close();
  });
});
