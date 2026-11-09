import { test, expect, type Page } from '@playwright/test'
import { createHash, randomUUID } from 'node:crypto'

async function connected(page: Page, count: number) {
  await expect.poll(() => page.evaluate(() => [...((window as any).__DEBUG_PARTICIPANTS?.values() ?? [])]
    .filter((p: any) => p.connectionState === 'connected').length)).toBe(count)
}
async function mediaStats(page: Page) {
  return page.evaluate(() => (window as any).__DEBUG_MEETING_MEDIA ?? [])
}

for (const mode of ['direct', 'incoming-only', 'routed', 'adaptive']) test(`FIPS ${mode} group media, chat and leave`, async ({ browser }) => {
  // Adaptation deliberately waits for five healthy seconds before probing upward.
  if (mode === 'adaptive') test.setTimeout(60000)
  // Added recovery phases use the existing expectation deadlines throughout.
  if (mode === 'direct') test.setTimeout(150000)
  const routed = mode === 'routed'
  const contexts = await Promise.all([0, 1, 2].map(() => browser.newContext({ permissions: ['camera', 'microphone'] })))
  try {
    for (const [index, context] of contexts.entries()) await context.addInitScript(({ routed, incomingOnly }) => {
      const Original = window.RTCPeerConnection
      window.RTCPeerConnection = class extends Original {
        constructor(config?: RTCConfiguration) {
          if (routed) throw new Error('Direct connection unavailable in this test')
          super(config)
          ;((window as any).__TEST_CONNECTIONS ??= []).push(this)
        }
        createDataChannel(label: string, options?: RTCDataChannelInit): RTCDataChannel {
          if (incomingOnly) { this.close(); throw new Error('This participant can only accept incoming direct connections') }
          return super.createDataChannel(label, options)
        }
        addTrack(): RTCRtpSender { throw new Error('Meet must send media through FIPS') }
        addTransceiver(): RTCRtpTransceiver { throw new Error('Meet must send media through FIPS') }
      }
      const OriginalSocket = window.WebSocket
      window.WebSocket = class extends OriginalSocket {
        constructor(url: string | URL, protocols?: string | string[]) {
          const seed = new URL(url).pathname === '/fips'
          if (seed && (window as any).__BLOCK_FIPS_SEEDS) throw new Error('Routing servers disconnected')
          super(url, protocols)
          if (seed) ((window as any).__TEST_FIPS_SOCKETS ??= []).push(this)
        }
      }
      const listen = RTCDataChannel.prototype.addEventListener
      RTCDataChannel.prototype.addEventListener = function (type: string, listener: any, options?: any) {
        if (type === 'message' && typeof listener === 'function') {
          const receive = listener
          listener = function (this: RTCDataChannel, event: MessageEvent) {
            if ((window as any).__DROP_VIDEO && event.data?.byteLength > 700) {
              const count = (window as any).__DROPPED_VIDEO_COUNTER = ((window as any).__DROPPED_VIDEO_COUNTER ?? 0) + 1
              if (count % 3 === 0) return
            }
            receive.call(this, event)
          }
        }
        return listen.call(this, type, listener, options)
      }
      Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', { value: async () => {
        const canvas = document.createElement('canvas')
        canvas.width = 640; canvas.height = 360
        canvas.getContext('2d')!.fillRect(0, 0, 640, 360)
        return canvas.captureStream(10)
      } })
    }, { routed, incomingOnly: mode === 'incoming-only' && index === 1 })
    const [a, b, c] = await Promise.all(contexts.map(c => c.newPage()))
    await a.goto('/')
    await a.getByPlaceholder('Name').fill('Alice')
    await a.getByRole('button', { name: 'Join', exact: true }).click()
    await a.getByRole('button', { name: 'Start Meeting' }).click()
    await expect(a.getByTitle('Leave meeting')).toBeVisible()
    const url = a.url()
    await b.goto(url)
    await b.getByPlaceholder('Name').fill('Bob')
    await b.getByRole('button', { name: 'Join Meeting', exact: true }).click()
    await connected(a, 1); await connected(b, 1)
    await a.getByTitle('Unmute microphone').click()
    await expect.poll(async () => (await mediaStats(b)).some((s: any) => s.audio > 5 && s.energy > 0)).toBe(true)
    await a.getByTitle('Turn on camera').click()
    await expect.poll(async () => (await mediaStats(b)).some((s: any) => s.video > 5)).toBe(true)
    await expect.poll(() => b.locator('video').evaluateAll(videos => videos.some(video => video.videoWidth === 1280 && video.videoHeight === 720))).toBe(true)
    await b.screenshot({ path: `work/fips-migration/${routed ? 'routed' : 'direct'}-received-video.png` })
    await c.goto(url)
    await c.getByPlaceholder('Name').fill('Carol')
    await c.getByRole('button', { name: 'Join Meeting', exact: true }).click()
    for (const page of [a, b, c]) await connected(page, 2)
    await expect.poll(async () => (await mediaStats(c)).some((s: any) => s.video > 2 && s.audio > 5)).toBe(true)
    if (mode === 'direct') {
      const original = await c.evaluate(() => [...(window as any).__DEBUG_PARTICIPANTS.values()]
        .map((participant: any) => ({
          account: participant.pubkey, session: participant.fipsPeer, name: participant.displayName,
        }))) as Array<{ account: string; session: string; name: string }>
      // Meet deliberately rotates FIPS session keys on every join. Preserve
      // account identity and replace the old session; never persist a session key.
      for (const [endpoint, sender, receiver, name] of [[0, a, b, 'Alice'], [1, b, a, 'Bob']] as const) {
        // Restore the existing local seed only for bootstrap; fresh delivery
        // below runs after all seed sockets are disabled again.
        for (const page of [a, b, c]) await page.evaluate(() => { (window as any).__BLOCK_FIPS_SEEDS = false })
        const previous = original.find(participant => participant.name === name)!
        expect(previous.account).toMatch(/^[0-9a-f]{64}$/)
        expect(previous.session).toMatch(/^(02|03)[0-9a-f]{64}$/)
        await sender.reload()
        await expect(sender.getByTitle('Leave meeting')).toBeVisible()
        await Promise.all([a, b, c].map(page => connected(page, 2)))
        await expect.poll(() => c.evaluate(({ account, oldSession }) => {
          const roster = [...(window as any).__DEBUG_PARTICIPANTS.values()] as any[]
          const matches = roster.filter(participant => participant.pubkey === account)
          return {
            accounts: matches.length,
            connected: matches[0]?.connectionState === 'connected',
            rotated: typeof matches[0]?.fipsPeer === 'string' && matches[0].fipsPeer !== oldSession,
            oldSessionRemoved: !roster.some(participant => participant.fipsPeer === oldSession),
          }
        }, { account: previous.account, oldSession: previous.session })).toEqual({
          accounts: 1, connected: true, rotated: true, oldSessionRemoved: true,
        })
        await Promise.all([a, b, c].map(page => expect.poll(() => page.evaluate(oldSession =>
          [...(window as any).__DEBUG_PARTICIPANTS.values()]
            .some((participant: any) => participant.fipsPeer === oldSession), previous.session)
        ).toBe(false)))
        // Recovery must reach direct data channels before the routing seed is
        // disconnected again. The fresh message then has no routed fallback.
        await Promise.all([a, b, c].map(page => expect.poll(() => page.evaluate(() =>
          ((window as any).__TEST_CONNECTIONS ?? []).filter((pc: RTCPeerConnection) =>
            pc.connectionState === 'connected' && pc.getSenders().length === 0).length
        )).toBe(2)))
        for (const page of [a, b, c]) await page.evaluate(() => {
          ;(window as any).__BLOCK_FIPS_SEEDS = true
          for (const socket of (window as any).__TEST_FIPS_SOCKETS ?? []) socket.close()
        })
        for (const page of [sender, receiver]) {
          if (!await page.getByPlaceholder('Type a message...').isVisible()) {
            await page.getByTitle('Open chat').click()
          }
        }
        const nonce = `recovered-${randomUUID()}`
        await expect(receiver.getByText(nonce, { exact: true })).toHaveCount(0)
        await sender.getByPlaceholder('Type a message...').fill(nonce)
        await sender.getByPlaceholder('Type a message...').press('Enter')
        await expect(receiver.getByText(nonce, { exact: true })).toBeVisible()
        for (const page of [sender, receiver]) await page.getByTitle('Close chat').click()
        console.log('PEER_RELOAD_RECOVERY', JSON.stringify({
          app: 'iris-meet', endpoint, reloaded: true, accountIdentityPreserved: true,
          sessionIdentityRotated: true, oldSessionRemoved: true, peerRecovered: true,
          freshHash: createHash('sha256').update(nonce).digest('hex'),
          bytes: Buffer.byteLength(nonce), transport: 'direct-fips',
        }))
      }
    }
    if (!routed) {
      for (const page of [a, b, c]) await expect.poll(() => page.evaluate(() => ((window as any).__TEST_CONNECTIONS ?? [])
        .filter((pc: RTCPeerConnection) => pc.connectionState === 'connected' && pc.getSenders().length === 0).length)).toBe(2)
      for (const page of [a, b, c]) await page.evaluate(() => {
        ;(window as any).__BLOCK_FIPS_SEEDS = true
        for (const socket of (window as any).__TEST_FIPS_SOCKETS ?? []) socket.close()
      })
      const before = (await mediaStats(b)).reduce((n: number, s: any) => n + s.video, 0)
      const audioBefore = (await mediaStats(b)).reduce((n: number, s: any) => n + s.audio, 0)
      await expect.poll(async () => (await mediaStats(b)).reduce((n: number, s: any) => n + s.video, 0)).toBeGreaterThan(before + 30)
      await expect.poll(async () => (await mediaStats(b)).reduce((n: number, s: any) => n + s.audio, 0)).toBeGreaterThan(audioBefore + 50)
    }
    for (const page of [a, b, c]) await page.getByTitle('Open chat').click()
    await a.getByPlaceholder('Type a message...').fill('Through FIPS')
    await a.getByPlaceholder('Type a message...').press('Enter')
    for (const page of [b, c]) await expect(page.getByText('Through FIPS', { exact: true })).toBeVisible()
    if (mode === 'adaptive') {
      const readVideo = () => a.evaluate(() => (window as any).__DEBUG_MEETING_VIDEO)
      const healthyBefore = (await mediaStats(c)).reduce((n: number, s: any) => n + s.video, 0)
      const audioBefore = (await mediaStats(b)).reduce((n: number, s: any) => n + s.audio, 0)
      await b.evaluate(() => { (window as any).__DROP_VIDEO = true })
      await expect.poll(async () => (await readVideo()).bitrate).toBeLessThan(500000)
      expect((await readVideo()).width).toBeLessThanOrEqual(480)
      expect((await readVideo()).framerate).toBeLessThanOrEqual(15)
      await expect.poll(async () => (await mediaStats(c)).reduce((n: number, s: any) => n + s.video, 0)).toBeGreaterThan(healthyBefore + 3)
      await expect.poll(async () => (await mediaStats(b)).reduce((n: number, s: any) => n + s.audio, 0)).toBeGreaterThan(audioBefore + 10)
      await b.evaluate(() => { (window as any).__DROP_VIDEO = false })
      await expect.poll(() => b.locator('video').evaluateAll(videos => videos.some(video => video.videoHeight > 0 && video.videoHeight <= 270))).toBe(true)
      await b.screenshot({ path: 'work/fips-migration/adaptive-reduced.png' })
      await expect.poll(async () => (await readVideo()).bitrate, { timeout: 35000 }).toBeGreaterThanOrEqual(1000000)
      await expect.poll(() => b.locator('video').evaluateAll(videos => videos.some(video => video.videoWidth === 1280 && video.videoHeight === 720))).toBe(true)
      await b.screenshot({ path: 'work/fips-migration/adaptive-recovered.png' })
    }
    await a.getByTitle('Share screen', { exact: true }).click()
    await expect(a.getByTitle('Stop sharing', { exact: true })).toBeVisible()
    await expect.poll(() => b.evaluate(() => [...(window as any).__DEBUG_PARTICIPANTS.values()].some((p: any) => p.screenSharing))).toBe(true)
    await expect.poll(() => b.locator('video').evaluateAll(videos => videos.some(video => video.videoWidth === 640 && video.videoHeight === 360))).toBe(true)
    await a.getByTitle('Stop sharing', { exact: true }).click()
    await expect(a.getByTitle('Share screen', { exact: true })).toBeVisible()
    await expect.poll(() => b.locator('video').evaluateAll(videos => videos.some(video => video.videoWidth === 1280 && video.videoHeight === 720))).toBe(true)
    await b.getByTitle('Leave meeting').click()
    await expect(a.getByTestId('video-tile')).toHaveCount(2)
    await a.screenshot({ path: `work/fips-migration/${routed ? 'routed' : 'direct'}-meeting.png` })
    for (const page of [a, c]) await page.getByTitle('Leave meeting').click()
    await expect.poll(() => a.evaluate(() => ((window as any).__TEST_CONNECTIONS ?? []).every((pc: RTCPeerConnection) => pc.connectionState === 'closed'))).toBe(true)
  } finally { await Promise.all(contexts.map(context => context.close())) }
})

test('enabling the microphone during device setup keeps it enabled', async ({ browser }) => {
  const aContext = await browser.newContext({ permissions: ['camera', 'microphone'] })
  const bContext = await browser.newContext({ permissions: ['camera', 'microphone'] })
  try {
    await aContext.addInitScript(() => {
      const enumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices)
      let first = true
      let release!: () => void
      const enabled = new Promise<void>(resolve => { release = resolve })
      navigator.mediaDevices.enumerateDevices = async () => {
        const devices = await enumerate()
        if (first) { first = false; await enabled }
        return devices
      }
      const setItem = Storage.prototype.setItem
      Storage.prototype.setItem = function (key, value) {
        setItem.call(this, key, value)
        if (key === 'iris-meet-media-prefs' && JSON.parse(value).audioEnabled) release()
      }
    })
    const a = await aContext.newPage(), b = await bContext.newPage()
    await a.goto('/')
    await a.getByPlaceholder('Name').fill('Alice')
    await a.getByRole('button', { name: 'Join', exact: true }).click()
    await a.getByRole('button', { name: 'Start Meeting' }).click()
    await a.getByTitle('Unmute microphone').click()
    await b.goto(a.url())
    await b.getByPlaceholder('Name').fill('Bob')
    await b.getByRole('button', { name: 'Join Meeting', exact: true }).click()
    await connected(b, 1)
    await expect.poll(async () => (await mediaStats(b)).some((s: any) => s.audio > 5 && s.energy > 0)).toBe(true)
    await expect(a.getByTitle('Mute microphone', { exact: false })).toBeVisible()
  } finally { await Promise.all([aContext.close(), bContext.close()]) }
})
