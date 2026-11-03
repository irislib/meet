import { expect, test } from '@playwright/test'
import { finalizeEvent } from 'nostr-tools'
import legacy from './fixtures/legacy-event-index.json' with { type: 'json' }

// The fixture contains the encrypted blocks and root emitted by Meet's 0.5.11 runtime.
test('reads a legacy event index, updates it with a versioned key and reopens both profiles', async ({ page }) => {
  const fixture = '/e2e/fixtures/eventIndex.ts'
  await page.addInitScript(() => localStorage.setItem('iris-meet-identity', '19'.repeat(32)))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Start a Meeting' })).toBeVisible()
  await page.evaluate(async fixture => (await import(fixture)).seedLegacyIndex(), fixture)
  expect(await page.evaluate(async ({ fixture, id }) => (await import(fixture)).cachedIds([id]), { fixture, id: legacy.id })).toEqual([legacy.id])
  const fresh = finalizeEvent({ kind: 0, tags: [], created_at: 1700000001, content: '{"name":"After upgrade"}' }, new Uint8Array(32).fill(24))
  await page.evaluate(async event => {
    const path = '/src/lib/nostr.ts'
    await (await import(path)).getNostrRuntime().publish(event, { sources: [] })
  }, fresh)
  const key = await page.evaluate(async fixture => (await import(fixture)).rootKey(), fixture)
  expect(key).toHaveLength(33)
  expect(key[0]).toBe(1)
  await page.reload()
  const ids = [legacy.id, fresh.id].sort()
  expect(await page.evaluate(async ({ fixture, ids }) => (await import(fixture)).cachedIds(ids), { fixture, ids })).toEqual(ids)
})
