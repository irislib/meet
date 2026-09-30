import { expect, test } from '@playwright/test'

test('restores existing identity and display name while fully offline', async ({ page, context }) => {
  await page.goto('/')
  await page.getByPlaceholder('Name').fill('Offline attendee')
  await page.getByRole('button', { name: 'Join' }).click()
  await expect(page.getByRole('heading', { name: 'Start a Meeting' })).toBeVisible()
  const before = await page.evaluate(() => localStorage.getItem('iris-meet-identity'))
  expect(before).toMatch(/^[0-9a-f]{64}$/)
  await page.evaluate(async () => { await navigator.serviceWorker.ready })
  await page.reload()
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
  await context.setOffline(true)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Start a Meeting' })).toBeVisible()
  await expect(page.getByText('Offline attendee')).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('iris-meet-identity'))).toBe(before)
})
