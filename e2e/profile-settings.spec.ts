import { expect, test } from '@playwright/test';
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { bytesToHex } from 'nostr-tools/utils';

test('profile settings show the signed-in profile and copy its local key only on request', async ({ page }, testInfo) => {
  const secret = generateSecretKey();
  const pubkey = getPublicKey(secret);
  await page.addInitScript(({ hex, pubkey, nsec }) => {
    if (!sessionStorage.getItem('test-profile-started')) {
      localStorage.setItem('iris-meet-identity', hex);
      localStorage.setItem('iris-meet-local-profile', JSON.stringify({ pubkey, name: 'Meeting profile' }));
      sessionStorage.setItem('test-profile-started', 'true');
    }
    Object.defineProperty(navigator, 'clipboard', { value: {
      writeText: async (value: string) => {
        sessionStorage.setItem('test-profile-key-matches', String(value === nsec));
      },
    } });
  }, { hex: bytesToHex(secret), pubkey, nsec: nip19.nsecEncode(secret) });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Start a Meeting' })).toBeVisible();
  await page.getByRole('button', { name: 'Profile menu' }).click();
  await page.getByRole('button', { name: 'Profile settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Profile settings' });
  await expect(settings.getByText('Meeting profile', { exact: true })).toBeVisible();
  await expect(settings).toContainText(nip19.npubEncode(pubkey));
  await expect(settings.getByText(/nsec1[0-9a-z]+/)).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('test-profile-key-matches'))).toBeNull();
  await settings.getByRole('button', { name: 'Copy secret key' }).click();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('test-profile-key-matches'))).toBe('true');
  await settings.screenshot({ path: testInfo.outputPath('profile-settings.png') });

  await page.evaluate((otherKey) => {
    localStorage.setItem('iris-meet-identity', otherKey);
    sessionStorage.removeItem('test-profile-key-matches');
  }, bytesToHex(generateSecretKey()));
  await settings.getByRole('button', { name: 'Copy secret key' }).click();
  await expect(settings.getByRole('alert')).toHaveText('Could not copy the secret key.');
  expect(await page.evaluate(() => sessionStorage.getItem('test-profile-key-matches'))).toBeNull();

  await settings.getByRole('button', { name: 'Sign out' }).click();
  const confirmation = page.getByRole('dialog', { name: 'Log out?' });
  await expect(confirmation).toContainText('Save your private key');
  await confirmation.getByRole('button', { name: 'Cancel' }).click();
  await expect(settings).toBeVisible();
  await settings.getByRole('button', { name: 'Sign out' }).click();
  await confirmation.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Already have a profile?' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Already have a profile?' })).toBeVisible();
});
