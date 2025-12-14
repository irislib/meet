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

  test('users see each others names in meeting', async ({ browser }) => {
    // Create two browser contexts with different users
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

    // User 1: Login with name "Alice" and create a meeting
    await page1.goto('/');
    await page1.getByPlaceholder('Name').fill('Alice');
    await page1.getByRole('button', { name: 'Join' }).click();
    await expect(page1.getByRole('heading', { name: 'Start a Meeting' })).toBeVisible({ timeout: 15000 });
    await page1.getByRole('button', { name: 'Start Meeting' }).click();
    await expect(page1.getByTitle('Leave meeting')).toBeVisible({ timeout: 15000 });

    // Get the meeting URL
    const meetingUrl = page1.url();

    // User 2: Go directly to meeting URL, login with name "Bob", and join
    await page2.goto(meetingUrl);
    await page2.getByPlaceholder('Name').fill('Bob');
    // Button says "Join Meeting" when there's a meeting hash in URL
    await page2.getByRole('button', { name: 'Join Meeting' }).click();
    await expect(page2.getByTitle('Leave meeting')).toBeVisible({ timeout: 15000 });

    // Wait for WebRTC connection
    await expect(page1.getByTestId('video-tile')).toHaveCount(2, { timeout: 15000 });
    await expect(page2.getByTestId('video-tile')).toHaveCount(2, { timeout: 15000 });

    // User 1 should see "Alice (You)" and "Bob"
    await expect(page1.getByText('Alice')).toBeVisible();
    await expect(page1.getByText('(You)')).toBeVisible();
    await expect(page1.getByText('Bob')).toBeVisible({ timeout: 10000 });

    // User 2 should see "Bob (You)" and "Alice"
    await expect(page2.getByText('Bob')).toBeVisible();
    await expect(page2.getByText('(You)')).toBeVisible();
    await expect(page2.getByText('Alice')).toBeVisible({ timeout: 10000 });

    // Clean up
    await context1.close();
    await context2.close();
  });

  test('users receive each others video streams when camera enabled', async ({ browser }) => {
    // Create two browser contexts
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
    await page1.getByRole('button', { name: 'Start Meeting' }).click();
    await expect(page1.getByTitle('Leave meeting')).toBeVisible({ timeout: 15000 });

    // Get the meeting URL
    const meetingUrl = page1.url();

    // User 2: Join the same meeting
    await page2.goto(meetingUrl);
    await page2.getByRole('button', { name: 'Join Meeting' }).click();
    await expect(page2.getByTitle('Leave meeting')).toBeVisible({ timeout: 15000 });

    // Wait for WebRTC connection (2 tiles = local + remote)
    await expect(page1.getByTestId('video-tile')).toHaveCount(2, { timeout: 15000 });
    await expect(page2.getByTestId('video-tile')).toHaveCount(2, { timeout: 15000 });

    // Both users enable their cameras
    await page1.getByTitle('Turn on camera').click();
    await expect(page1.getByTitle('Turn off camera')).toBeVisible({ timeout: 10000 });

    await page2.getByTitle('Turn on camera').click();
    await expect(page2.getByTitle('Turn off camera')).toBeVisible({ timeout: 10000 });

    // Wait for renegotiation and verify remote video is playing
    // Check that both pages have video elements with srcObject that has video tracks
    await expect(async () => {
      // Check page1 sees page2's video
      const page1HasRemoteVideo = await page1.evaluate(() => {
        const videos = document.querySelectorAll('video');
        let hasRemoteStream = false;
        videos.forEach(video => {
          const stream = video.srcObject as MediaStream;
          if (stream && stream.getVideoTracks().length > 0 && !video.muted) {
            hasRemoteStream = true;
          }
        });
        return hasRemoteStream;
      });
      expect(page1HasRemoteVideo).toBe(true);
    }).toPass({ timeout: 15000 });

    await expect(async () => {
      // Check page2 sees page1's video
      const page2HasRemoteVideo = await page2.evaluate(() => {
        const videos = document.querySelectorAll('video');
        let hasRemoteStream = false;
        videos.forEach(video => {
          const stream = video.srcObject as MediaStream;
          if (stream && stream.getVideoTracks().length > 0 && !video.muted) {
            hasRemoteStream = true;
          }
        });
        return hasRemoteStream;
      });
      expect(page2HasRemoteVideo).toBe(true);
    }).toPass({ timeout: 15000 });

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
