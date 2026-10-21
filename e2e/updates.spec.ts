import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import { test, expect, type Page } from '@playwright/test'

// Serve two releases from the same origin so a returning browser really uses
// its installed service worker. Fresh-context call tests cannot cover this.
async function releases() {
  let version = 1
  const root = resolve('dist')
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, 'http://localhost').pathname
    try {
      const file = path === '/' ? '/index.html' : path
      let body = await readFile(resolve(root, `.${file}`))
      if (file === '/index.html') body = Buffer.from(body.toString().replace('<body>', `<body data-release="${version}">`))
      if (file === '/sw.js') body = Buffer.from(body.toString().replace(/(url:"index.html",revision:")[^"]+/, `$1test-release-${version}`))
      response.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' } as Record<string, string>)[extname(file)] ?? 'application/octet-stream')
      response.setHeader('Cache-Control', 'no-store')
      response.end(body)
    } catch { response.writeHead(404).end() }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as { port: number }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    publish: () => { version++ },
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
  }
}

async function installed(page: Page) {
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
}

async function checkForUpdate(page: Page) {
  await page.bringToFront()
  // A tab can remain open across releases. Exercise the app's foreground
  // update check instead of manually invoking ServiceWorkerRegistration.update.
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
}

async function localNetwork(page: Page) {
  // The production bundle uses public endpoints. Keep this upgrade regression
  // deterministic while using the real discovery and call transports.
  await page.addInitScript(({ relay, seed }) => {
    const Original = window.WebSocket
    window.WebSocket = class extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(new URL(url).pathname === '/fips' ? seed : relay, protocols)
      }
    }
  }, {
    relay: `ws://127.0.0.1:${process.env.PW_RELAY_PORT ?? 49319}`,
    seed: `ws://127.0.0.1:${Number(process.env.PW_FIPS_PORT ?? 49320) + 1}/fips`,
  })
}

async function connected(page: Page) {
  await expect(page.getByTestId('video-tile')).toHaveCount(2)
  await expect.poll(() => page.evaluate(() => [...(window as any).__DEBUG_PARTICIPANTS.values()]
    .filter((participant: any) => participant.connectionState === 'connected').length)).toBe(1)
}

test('a cached browser updates and connects to a fresh private session', async ({ page, browser }) => {
  const site = await releases()
  const fresh = await browser.newContext()
  try {
    await localNetwork(page)
    await page.goto(site.url)
    await page.getByPlaceholder('Name').fill('Returning attendee')
    await page.getByRole('button', { name: 'Join', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Start a Meeting' })).toBeVisible()
    await installed(page)
    const identity = await page.evaluate(() => localStorage.getItem('iris-meet-identity'))
    site.publish()
    await checkForUpdate(page)
    await expect(page.locator('body')).toHaveAttribute('data-release', '2')
    await expect(page.getByRole('heading', { name: 'Start a Meeting' })).toBeVisible()
    await expect(page.getByText('Returning attendee', { exact: true })).toBeVisible()
    expect(await page.evaluate(() => localStorage.getItem('iris-meet-identity'))).toBe(identity)
    await page.getByRole('button', { name: 'Start Meeting', exact: true }).click()
    await expect(page.getByText('(You)')).toBeVisible()
    const other = await fresh.newPage()
    await localNetwork(other)
    await other.goto(page.url())
    await other.getByRole('button', { name: 'Join Meeting', exact: true }).click()
    await connected(page)
    await connected(other)
  } finally { await fresh.close(); await page.close(); await site.close() }
})

test('an update offers to reload a connected room without interrupting it', async ({ page, browser }, testInfo) => {
  const site = await releases()
  const fresh = await browser.newContext()
  try {
    await localNetwork(page)
    await page.goto(site.url)
    await page.getByRole('button', { name: 'Join', exact: true }).click()
    await page.getByRole('button', { name: 'Start Meeting', exact: true }).click()
    await expect(page.getByText('(You)')).toBeVisible()
    await installed(page)
    const room = page.url()
    const other = await fresh.newPage()
    await localNetwork(other)
    await other.goto(room)
    await other.getByRole('button', { name: 'Join Meeting', exact: true }).click()
    await connected(page)
    await connected(other)
    site.publish()
    await checkForUpdate(page)
    await expect(page.getByRole('button', { name: 'Reload to update' })).toBeVisible()
    await expect(page.locator('body')).toHaveAttribute('data-release', '1')
    await expect(page.getByText('(You)')).toBeVisible()
    expect(page.url()).toBe(room)
    await connected(page)
    await connected(other)
    await page.screenshot({ path: testInfo.outputPath('update-in-call.png') })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: testInfo.outputPath('update-in-call-mobile.png') })
    await page.getByRole('button', { name: 'Reload to update' }).click()
    await expect(page.locator('body')).toHaveAttribute('data-release', '2')
    await expect(page.getByText('(You)')).toBeVisible()
    expect(page.url()).toBe(room)
    await connected(page)
    await connected(other)
  } finally { await fresh.close(); await page.close(); await site.close() }
})
