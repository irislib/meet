import { expect, test } from '@playwright/test'
import { finalizeEvent, getPublicKey, nip44 } from 'nostr-tools'

const secret = '15'.repeat(32)
const pubkey = getPublicKey(Uint8Array.from(secret.match(/../g)!, byte => parseInt(byte, 16)))

test('nostr-pubsub discovers a late participant through FIPS when relays are unavailable', async ({ browser }) => {
  const contexts = await Promise.all([0, 1, 2].map(() => browser.newContext()))
  const pages = await Promise.all(contexts.map(context => context.newPage()))
  const diagnostics: string[] = []
  pages.forEach((page, index) => {
    page.on('console', message => { if (['warning', 'error'].includes(message.type())) diagnostics.push(`${index}: ${message.text()}`) })
    page.on('pageerror', error => diagnostics.push(`${index}: ${error.message}`))
  })
  try {
    for (const [index, context] of contexts.entries()) await context.addInitScript(index => {
      localStorage.setItem('iris-meet-identity', ['15', '31', '41'][index].repeat(32))
      const Original = window.WebSocket
      window.WebSocket = class extends Original {
        constructor(url: string | URL, protocols?: string | string[]) {
          const test = window as any
          const seed = new URL(url).pathname === '/fips'
          const relay = !seed && protocols !== 'vite-hmr'
          if ((seed && test.__BLOCK_SEEDS) || (relay && test.__BLOCK_RELAYS)) throw new Error('Disconnected for test')
          super(url, protocols)
          if (seed || relay) (test[seed ? '__SEEDS' : '__RELAYS'] ??= []).push(this)
        }
      }
    }, index)
    const [a, b, c] = pages
    await a.goto('/')
    await a.getByRole('button', { name: 'Start Meeting' }).click()
    await expect(a.getByTitle('Leave meeting')).toBeVisible()
    await b.goto(a.url())
    for (const page of [a, b]) await expect.poll(() => page.evaluate(() =>
      [...(window as any).__DEBUG_PARTICIPANTS.values()].filter((p: any) => p.connectionState === 'connected').length,
    )).toBe(1)
    await b.evaluate(async () => {
      const runtimePath = '/src/lib/nostr.ts', meetingPath = '/src/lib/meetingSession.ts'
      const runtime = (await import(runtimePath)).getNostrRuntime()
      const room = (await import(meetingPath)).getMeetingPubkey()
      ;(window as any).__FIPS_EVENTS = []
      runtime.subscribe([{ kinds: [25050], authors: [room] }], {
        onEvent: (event: any, info: any) => (window as any).__FIPS_EVENTS.push({ id: event.id, source: info.source }),
      }, { cache: 'network-only', relays: [], sources: ['fips'], localEcho: false })
      ;(window as any).__BLOCK_RELAYS = true
      for (const socket of (window as any).__RELAYS) socket.close()
    })
    await c.goto(a.url())
    for (const page of [a, b, c]) await expect.poll(() => page.evaluate(() =>
      [...(window as any).__DEBUG_PARTICIPANTS.values()].filter((p: any) => p.connectionState === 'connected').length,
    )).toBe(2)
    expect(await b.evaluate(() => (window as any).__FIPS_EVENTS.some((event: any) => event.source === 'fips'))).toBe(true)
    expect(await b.evaluate(async () => {
      const path = '/src/lib/nostr.ts'
      const ids = (window as any).__FIPS_EVENTS.map((event: any) => event.id)
      return (await (await import(path)).getNostrRuntime().query([{ ids }], { cache: 'cache-only' })).events
    })).toEqual([])
    for (const page of [a, b, c]) {
      await page.evaluate(() => {
        ;(window as any).__BLOCK_RELAYS = true
        for (const socket of (window as any).__RELAYS) socket.close()
      })
      await page.getByTitle('Open chat').click()
    }
    await c.getByPlaceholder('Type a message...').fill('Joined through nostr-pubsub over FIPS')
    await c.getByPlaceholder('Type a message...').press('Enter')
    for (const page of [a, b]) await expect(page.getByText('Joined through nostr-pubsub over FIPS', { exact: true })).toBeVisible()
    await b.getByTitle('Leave meeting').click()
    for (const page of [a, c]) await expect(page.getByTestId('video-tile')).toHaveCount(2)
  } catch (error) {
    console.log('Discovery errors', diagnostics.slice(-30))
    for (const [index, page] of pages.entries()) {
      console.log('Discovery state', index, await page.evaluate(() => {
        return {
          participants: [...(window as any).__DEBUG_PARTICIPANTS.values()],
          events: (window as any).__FIPS_EVENTS,
        }
      }))
      await page.screenshot({ path: `work/fips-migration/security-discovery-failure-${index}.png` })
    }
    throw error
  } finally { await Promise.all(contexts.map(context => context.close())) }
})

test('restores the existing secret key and persists verified public profiles across reload', async ({ page }) => {
  await page.addInitScript(secret => localStorage.setItem('iris-meet-identity', secret), secret)
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Start a Meeting' })).toBeVisible()
  const eventId = await page.evaluate(async () => {
    const path = '/src/lib/nostr.ts', identityPath = '/src/lib/identity.ts'
    let current: any
    ;(await import(identityPath)).identity.subscribe((value: any) => { current = value })()
    const event = await current.signer.signEvent({ kind: 0, created_at: Math.floor(Date.now() / 1000), tags: [], content: JSON.stringify({ name: 'Stored public profile' }) })
    await (await import(path)).getNostrRuntime().publish(event, { sources: [] })
    return event.id
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
    const runtimePath = '/src/lib/nostr.ts', identityPath = '/src/lib/identity.ts', discoveryPath = '/src/lib/meetingDiscovery.ts'
    const { getNostrRuntime } = await import(runtimePath)
    const { PRESENCE_PUBLISH_OPTIONS } = await import(discoveryPath)
    let current: any
    ;(await import(identityPath)).identity.subscribe((value: any) => { current = value })()
    const signed = await current.signer.signEvent({ kind: 25050, created_at: Math.floor(Date.now() / 1000), tags: [], content: 'encrypted-call-setup' })
    const receipt = await getNostrRuntime().publish(signed, PRESENCE_PUBLISH_OPTIONS)
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
    const runtimePath = '/src/lib/nostr.ts', identityPath = '/src/lib/identity.ts'
    let current: any
    ;(await import(identityPath)).identity.subscribe((value: any) => { current = value })()
    const event = await current.signer.signEvent({ kind: 0, created_at: Math.floor(Date.now() / 1000), tags: [], content: '{"name":"Extension user"}' })
    await (await import(runtimePath)).getNostrRuntime().publish(event, { sources: [] })
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
