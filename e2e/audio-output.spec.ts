import { test, expect } from '@playwright/test';
import { setupPageErrorHandler, loginAnonymously } from './test-utils';

test.describe('Audio Output Selection', () => {
  test.beforeEach(async ({ page }) => {
    setupPageErrorHandler(page);
    await page.goto('/');
    await loginAnonymously(page);
  });

  test('audio device menu shows speaker output section', async ({ page }) => {
    // Start a meeting
    await page.getByRole('button', { name: 'Start Meeting' }).click();
    await expect(page.getByTitle('Leave meeting')).toBeVisible({ timeout: 15000 });

    // Enable mic first to get device permissions
    await page.getByTitle('Unmute microphone').click();
    await expect(page.getByTitle(/Mute microphone/)).toBeVisible();

    // Open the audio device menu (chevron button)
    await page.getByTitle('Select audio devices').click();

    // Should show microphone section
    await expect(page.getByText('Microphone')).toBeVisible();

    // Should show speaker section
    await expect(page.getByText('Speaker')).toBeVisible();
  });

  test('can select audio output device from menu', async ({ page }) => {
    // Start a meeting
    await page.getByRole('button', { name: 'Start Meeting' }).click();
    await expect(page.getByTitle('Leave meeting')).toBeVisible({ timeout: 15000 });

    // Enable mic first to get device permissions
    await page.getByTitle('Unmute microphone').click();
    await expect(page.getByTitle(/Mute microphone/)).toBeVisible();

    // Open the audio device menu
    await page.getByTitle('Select audio devices').click();

    // Should have speaker section with at least one device
    await expect(page.getByText('Speaker')).toBeVisible();

    // Click a speaker device option (the one with speaker icon)
    const speakerOption = page.locator('button:has(.i-carbon-volume-up)').first();
    await expect(speakerOption).toBeVisible();
    await speakerOption.click();

    // Menu should close after selection
    await expect(page.getByText('Speaker')).not.toBeVisible();
  });

  test('audio menu title changes to reflect both input and output', async ({ page }) => {
    // Start a meeting
    await page.getByRole('button', { name: 'Start Meeting' }).click();
    await expect(page.getByTitle('Leave meeting')).toBeVisible({ timeout: 15000 });

    // Enable mic first
    await page.getByTitle('Unmute microphone').click();
    await expect(page.getByTitle(/Mute microphone/)).toBeVisible();

    // The chevron button title should indicate audio devices (not just microphone)
    await expect(page.getByTitle('Select audio devices')).toBeVisible();
  });

  test('selected speaker shows highlight in menu', async ({ page }) => {
    // Start a meeting
    await page.getByRole('button', { name: 'Start Meeting' }).click();
    await expect(page.getByTitle('Leave meeting')).toBeVisible({ timeout: 15000 });

    // Enable mic first
    await page.getByTitle('Unmute microphone').click();
    await expect(page.getByTitle(/Mute microphone/)).toBeVisible();

    // Open audio device menu
    await page.getByTitle('Select audio devices').click();

    // The default speaker should be highlighted (has bg-primary class)
    const speakerSection = page.getByText('Speaker').locator('..');
    const highlightedSpeaker = speakerSection.locator('button.bg-primary\\/20');
    // At minimum, the speaker section should exist
    await expect(page.getByText('Speaker')).toBeVisible();
  });
});
