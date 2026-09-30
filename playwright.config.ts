import { defineConfig, devices } from '@playwright/test';

// The suite shares a single dev server, relay traffic, and fake media devices.
// Running tests concurrently makes signaling and data-channel timing flaky.
const appPort = process.env.PW_PORT ?? '49318';
const relayPort = process.env.PW_RELAY_PORT ?? '49319';
const usePreview = process.env.PW_PREVIEW === '1';
const baseURL = `http://127.0.0.1:${appPort}`;

const workers = process.env.PW_WORKERS ? parseInt(process.env.PW_WORKERS, 10) : 1;

export default defineConfig({
  testDir: './e2e',
  testIgnore: usePreview ? undefined : /offline\.spec\.ts/,
  testMatch: usePreview ? /offline\.spec\.ts/ : undefined,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers,
  reporter: 'list',
  timeout: 30000,
  expect: { timeout: 10000 },
  use: {
    baseURL,
    trace: 'off',
    actionTimeout: 10000,
    permissions: ['camera', 'microphone'],
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
          ],
        },
      },
    },
  ],
  webServer: [
    {
      command: 'node e2e/relay-server.mjs', url: `http://127.0.0.1:${relayPort}`,
      reuseExistingServer: false, env: { PW_RELAY_PORT: relayPort },
    },
    {
      command: `pnpm run ${usePreview ? 'preview' : 'dev'} --host 127.0.0.1 --port ${appPort} --strictPort`,
      url: baseURL, reuseExistingServer: false,
      env: { VITE_NOSTR_RELAYS: `ws://127.0.0.1:${relayPort},ws://127.0.0.1:${relayPort}/unresponsive` },
    },
  ],
});
