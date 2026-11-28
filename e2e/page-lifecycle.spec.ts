import { test, expect } from '@playwright/test'

test('a cached page transition preserves the two-person meeting', async ({ browser }) => {
  const a = await browser.newContext()
  const b = await browser.newContext()
  try {
    const host = await a.newPage()
    const guest = await b.newPage()
    await host.goto('/')
    await host.getByRole('button', { name: 'Join', exact: true }).click()
    await host.getByRole('button', { name: 'Start Meeting' }).click()
    await expect(host.getByTitle('Leave meeting')).toBeVisible()
    await guest.goto(host.url())
    await guest.getByRole('button', { name: 'Join Meeting', exact: true }).click()
    await expect(host.getByTestId('video-tile')).toHaveCount(2)
    await expect(guest.getByTestId('video-tile')).toHaveCount(2)

    // Active RTC connections can prevent Chromium's real back/forward cache.
    // Exercise the persisted lifecycle events without closing the live session.
    await guest.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }))
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
    })
    await host.getByTitle('Open chat').click()
    await guest.getByTitle('Open chat').click()
    await guest.getByPlaceholder('Type a message...').fill('Still here after history restore')
    await guest.getByPlaceholder('Type a message...').press('Enter')
    await expect(host.getByText('Still here after history restore', { exact: true })).toBeVisible()
    await expect(host.getByTestId('video-tile')).toHaveCount(2)
    await host.getByPlaceholder('Type a message...').fill('Both directions still work')
    await host.getByPlaceholder('Type a message...').press('Enter')
    await expect(guest.getByText('Both directions still work', { exact: true })).toBeVisible()

    // A real close still notifies the remaining participant promptly.
    await guest.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })))
    await expect(host.getByTestId('video-tile')).toHaveCount(1)
  } finally {
    await a.close()
    await b.close()
  }
})

test('a rejected pagehide leave does not become an unhandled rejection', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Join', exact: true }).click()
  await page.getByRole('button', { name: 'Start Meeting' }).click()
  await expect(page.getByTitle('Leave meeting')).toBeVisible()
  const unhandled = await page.evaluate(async () => {
    // Import the same dev-server module that owns the live session's transport.
    const { MeetingTransport } = await import('/src/lib/meetingTransport.ts')
    const original = MeetingTransport.prototype.sendLeave
    const errors: string[] = []
    const onUnhandled = (event: PromiseRejectionEvent) => {
      errors.push(String(event.reason))
      event.preventDefault()
    }
    window.addEventListener('unhandledrejection', onUnhandled)
    MeetingTransport.prototype.sendLeave = () => [Promise.reject(new Error('departed test peer'))]
    try {
      window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }))
      // Observe the next rendering task after promise rejection reporting.
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
      return errors
    } finally {
      MeetingTransport.prototype.sendLeave = original
      window.removeEventListener('unhandledrejection', onUnhandled)
    }
  })
  expect(unhandled).toEqual([])
})
