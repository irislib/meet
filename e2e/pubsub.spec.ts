import { expect, test } from '@playwright/test'
import { finalizeEvent, getPublicKey, nip44 } from 'nostr-tools'

const secret = '15'.repeat(32)
const pubkey = getPublicKey(Uint8Array.from(secret.match(/../g)!, byte => parseInt(byte, 16)))

test('restores the existing secret key and persists verified public profiles across reload', async ({ page }) => {
  await page.addInitScript(secret => localStorage.setItem('iris-meet-identity', secret), secret)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Start a Meeting' })).toBeVisible()
  const eventId = await page.evaluate(async () => {
    const path = '/src/lib/nostr.ts'
    const { nostr } = await import(path)
    return (await nostr.publishEvent({ kind: 0, content: JSON.stringify({ name: 'Stored public profile' }) })).id
  })
  await page.reload()
  const cached = await page.evaluate(async id => {
    const path = '/src/lib/nostr.ts'
    return (await (await import(path)).getNostrRuntime().query([{ ids: [id] }], { cache: 'cache-only' })).events
  }, eventId)
  expect(cached).toHaveLength(1)
  expect(cached[0].pubkey).toBe(pubkey)
  expect(await page.evaluate(() => localStorage.getItem('iris-meet-identity'))).toBe(secret)
})

test('never stores or queues encrypted meeting signals when offline', async ({ page, context }) => {
  await page.addInitScript(secret => localStorage.setItem('iris-meet-identity', secret), secret)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Start a Meeting' })).toBeVisible()
  // Load code before disabling HTTP so the test exercises the actual app runtime.
  await page.evaluate(async () => {
    const path = '/src/lib/nostr.ts'
    const { getNostrRuntime } = await import(path)
    getNostrRuntime().setRelays([])
  })
  await context.setOffline(true)
  const stored = await page.evaluate(async () => {
    const runtimePath = '/src/lib/nostr.ts'
    const { nostr, getNostrRuntime } = await import(runtimePath)
    const signed = await nostr.signEvent({ kind: 25050, content: 'encrypted-call-setup' })
    const receipt = await nostr.publish(signed)
    const history = await getNostrRuntime().query([{ ids: [signed.id] }], { cache: 'cache-only' })
    return { receipt, events: history.events }
  })
  expect(stored.receipt).toMatchObject({ accepted: false, queued: false })
  expect(stored.events).toEqual([])
})

test('restores extension sessions and delegates signing and NIP44 encryption', async ({ page }) => {
  const bytes = Uint8Array.from(secret.match(/../g)!, byte => parseInt(byte, 16))
  let signatures = 0
  await page.exposeFunction('signFixtureEvent', (draft: Parameters<typeof finalizeEvent>[0]) => {
    signatures += 1
    return finalizeEvent(draft, bytes)
  })
  await page.exposeFunction('encryptFixture', (recipient: string, plaintext: string) => nip44.v2.encrypt(plaintext, nip44.v2.utils.getConversationKey(bytes, recipient)))
  await page.exposeFunction('decryptFixture', (sender: string, ciphertext: string) => nip44.v2.decrypt(ciphertext, nip44.v2.utils.getConversationKey(bytes, sender)))
  await page.addInitScript(pubkey => {
    localStorage.setItem('iris-meet-identity', 'nip07')
    const fixture = window as unknown as {
      signFixtureEvent(draft: unknown): Promise<any>
      encryptFixture(pubkey: string, plaintext: string): Promise<string>
      decryptFixture(pubkey: string, ciphertext: string): Promise<string>
    }
    window.nostr = {
      getPublicKey: async () => pubkey,
      signEvent: draft => fixture.signFixtureEvent(draft),
      nip44: { encrypt: fixture.encryptFixture, decrypt: fixture.decryptFixture },
    }
  }, pubkey)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Start a Meeting' })).toBeVisible()
  expect(await page.evaluate(async pubkey => {
    const encryptionPath = '/src/lib/encryption.ts'
    const { encryptForPeer, decryptFromPeer } = await import(encryptionPath)
    const encrypted = await encryptForPeer({ message: 'encrypted via extension' }, pubkey)
    const runtimePath = '/src/lib/nostr.ts'
    await (await import(runtimePath)).nostr.publishEvent({ kind: 0, content: '{"name":"Extension user"}' })
    return decryptFromPeer(encrypted, pubkey)
  }, pubkey)).toEqual({ message: 'encrypted via extension' })
  expect(signatures).toBe(1)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Start a Meeting' })).toBeVisible()
  expect(await page.evaluate(() => localStorage.getItem('iris-meet-identity'))).toBe('nip07')
})

for (const reverseKeys of [false, true]) test(`meeting discovery keeps rooms isolated with ${reverseKeys ? 'reversed' : 'forward'} identity ordering`, async ({ browser }) => {
  const contexts = await Promise.all(Array.from({ length: 3 }, () => browser.newContext()))
  const keys = reverseKeys ? ['31', '41', '15'] : ['15', '41', '31']
  await Promise.all(contexts.map((context, index) => context.addInitScript(secret => localStorage.setItem('iris-meet-identity', secret), keys[index].repeat(32))))
  const [first, other, invited] = await Promise.all(contexts.map(context => context.newPage()))
  for (const page of [first, other]) {
    await page.goto('/')
    await page.getByRole('button', { name: 'Start Meeting' }).click()
    await expect(page.getByTitle('Leave meeting')).toBeVisible()
  }
  await invited.goto(first.url())
  await expect(invited.getByTitle('Leave meeting')).toBeVisible()
  await expect(first.getByTestId('video-tile')).toHaveCount(2)
  await expect(invited.getByTestId('video-tile')).toHaveCount(2)
  await expect(other.getByTestId('video-tile')).toHaveCount(1)
  for (const context of contexts) await context.close()
})
