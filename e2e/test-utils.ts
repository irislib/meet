/**
 * Shared test utilities for Iris Meet e2e tests
 */

import { expect, Page } from '@playwright/test';

/**
 * Filter out noisy errors from relays that are irrelevant to tests.
 */
export function setupPageErrorHandler(page: Page) {
  page.on('pageerror', (err: Error) => {
    const msg = err.message;
    if (!msg.includes('rate-limited') && !msg.includes('pow:') && !msg.includes('bits needed')) {
      console.log('Page error:', msg);
    }
  });
}

/**
 * Login with an optional display name.
 * In tests (no window.nostr), button says "Join" not "Join Anonymously"
 */
export async function loginAnonymously(page: Page, displayName?: string) {
  // Wait for the login form to be visible (button is "Join" when no NIP-07 extension)
  await expect(page.getByRole('button', { name: 'Join' })).toBeVisible();

  // Optionally enter a display name
  if (displayName) {
    await page.getByPlaceholder('Name').fill(displayName);
  }

  // Click "Join"
  await page.getByRole('button', { name: 'Join' }).click();

  // Wait for home screen
  await expect(page.getByRole('heading', { name: 'Start a Meeting' })).toBeVisible({ timeout: 15000 });
}

/**
 * Create a new meeting and return the meeting link.
 */
export async function createMeeting(page: Page): Promise<string> {
  // Click "Create Meeting"
  await page.getByRole('button', { name: 'Create Meeting' }).click();

  // Wait for meeting to be created
  await expect(page.getByRole('heading', { name: 'Meeting Created!' })).toBeVisible();

  // Get the meeting ID
  const meetingId = await page.locator('.font-mono').textContent();

  // Get the meeting link by clicking Copy Link and reading from clipboard
  // Since clipboard might not work in tests, we'll construct it from the URL
  await page.getByRole('button', { name: 'Copy Link' }).click();

  // Return the current page URL after clicking copy (it should have the nsec in hash)
  // We need to click Join Now first to get the full URL
  await page.getByRole('button', { name: 'Join Now' }).click();

  // Wait for meeting room to load
  await expect(page.getByText('Iris Meet')).toBeVisible({ timeout: 15000 });

  // Get the URL with the nsec
  const url = page.url();

  return url;
}

/**
 * Join a meeting using a link.
 */
export async function joinMeetingByLink(page: Page, meetingLink: string) {
  // Extract the nsec from the link
  const nsec = meetingLink.split('#')[1];

  // Paste the link into the join input
  await page.getByPlaceholder('Paste meeting link or nsec here').fill(meetingLink);

  // Click Join Meeting
  await page.getByRole('button', { name: 'Join Meeting' }).click();

  // Wait for meeting room to load
  await expect(page.locator('.text-lg.font-semibold:has-text("Iris Meet")')).toBeVisible({ timeout: 15000 });
}

/**
 * Leave the current meeting.
 */
export async function leaveMeeting(page: Page) {
  // Click the leave button (phone-off icon)
  await page.getByTitle('Leave meeting').click();

  // Wait for home screen
  await expect(page.getByRole('heading', { name: 'Start a Meeting' })).toBeVisible({ timeout: 10000 });
}

/**
 * Toggle microphone.
 */
export async function toggleMicrophone(page: Page) {
  const muteBtn = page.getByTitle(/microphone/i);
  await muteBtn.click();
}

/**
 * Toggle camera.
 */
export async function toggleCamera(page: Page) {
  const cameraBtn = page.getByTitle(/camera/i);
  await cameraBtn.click();
}

/**
 * Wait for a participant to appear in the meeting.
 */
export async function waitForParticipant(page: Page, name: string) {
  await expect(page.getByText(name)).toBeVisible({ timeout: 30000 });
}
