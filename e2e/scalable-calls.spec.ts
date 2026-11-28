import { test, expect, type Page } from '@playwright/test'
import { FipsNode, generateIdentity, toHex } from '@fips/core'
import { WebSocketTransport } from '@fips/transport-websocket'
import { BlindForwarderService } from '../src/lib/blindForwarderNode'
import { canonicalPeer } from '../src/lib/meetingTransport'
import { getPublicKey } from 'nostr-tools'
import { hexToBytes } from 'nostr-tools/utils'

async function connected(page: Page, count: number, timeout = 15000) {
  await expect.poll(() => page.evaluate(() => [...((window as any).__DEBUG_PARTICIPANTS?.values() ?? [])]
    .filter((p: any) => p.connectionState === 'connected').length), { timeout }).toBe(count)
}

async function remoteVideoSize(page: Page, name: string) {
  return page.locator('video').evaluateAll((videos, targetName) => {
    const peer = [...((window as any).__DEBUG_PARTICIPANTS?.values() ?? [])].find((p: any) => p.displayName === targetName)
    const video = videos.find(v => v.srcObject === peer?.stream)
    return video ? { width: video.videoWidth, height: video.videoHeight, frames: video.getVideoPlaybackQuality().totalVideoFrames } : null
  }, name)
}

test.describe('Scalable P2P group calling (IC04)', () => {
  test('receiver-driven simulcast isolates constrained thumbnail viewer from HD viewer and stops unused HD encoder', async ({ browser }, testInfo) => {
    test.setTimeout(90000)
    const contexts = await Promise.all([0, 1, 2].map(() => browser.newContext({ permissions: ['camera', 'microphone'] })))
    try {
      // Allow Bob (index 1) to simulate packet loss on incoming video datagrams.
      await contexts[1].addInitScript(() => {
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
      })

      const [alice, bob, carol] = await Promise.all(contexts.map(c => c.newPage()))
      await alice.goto('/')
      await alice.getByPlaceholder('Name').fill('Alice')
      await alice.getByRole('button', { name: 'Join', exact: true }).click()
      await alice.getByRole('button', { name: 'Start Meeting', exact: true }).click()
      await expect(alice.getByTitle('Leave meeting')).toBeVisible()
      const url = alice.url()

      for (const [page, name] of [[bob, 'Bob'], [carol, 'Carol']] as const) {
        await page.goto(url)
        await page.getByPlaceholder('Name').fill(name)
        await page.getByRole('button', { name: 'Join Meeting', exact: true }).click()
        await expect(page.getByTitle('Leave meeting')).toBeVisible()
      }
      for (const page of [alice, bob, carol]) await connected(page, 2)

      // Alice turns on camera & mic.
      await alice.getByTitle('Unmute microphone').click()
      await alice.getByTitle('Turn on camera').click()

      // Carol pins Alice (HD) while Bob requests thumbnail (low) and drops 1/3 of incoming video packets.
      await carol.evaluate(() => (window as any).__SET_MEETING_SUB_OVERRIDES({ Alice: { audio: true, video: 'high', screen: false } }))
      await bob.evaluate(() => {
        ;(window as any).__DROP_VIDEO = true
        ;(window as any).__SET_MEETING_SUB_OVERRIDES({ Alice: { audio: true, video: 'low', screen: false } })
      })

      // Carol stays at crisp 1280x720 HD while Bob receives <= 480x270 thumbnail cleanly!
      await expect.poll(async () => remoteVideoSize(carol, 'Alice'), { timeout: 20000 }).toMatchObject({ width: 1280, height: 720 })
      await expect.poll(async () => {
        const size = await remoteVideoSize(bob, 'Alice')
        return !!size && size.height > 0 && size.height <= 270
      }, { timeout: 20000 }).toBe(true)

      // Verify Alice's high layer stayed >= 1 Mbps despite Bob's packet loss.
      const aliceVideo = await alice.evaluate(() => (window as any).__DEBUG_MEETING_VIDEO)
      expect(aliceVideo.layers.high.active).toBe(true)
      expect(aliceVideo.layers.high.bitrate).toBeGreaterThanOrEqual(1_000_000)
      expect(aliceVideo.layers.low.active).toBe(true)
      expect(aliceVideo.layers.low.height).toBeLessThanOrEqual(270)

      await carol.screenshot({ path: testInfo.outputPath('simulcast-carol-hd.png') })
      await bob.screenshot({ path: testInfo.outputPath('simulcast-bob-low.png') })

      // Carol unpins HD -> switches to low -> Alice's HD encoder MUST stop completely!
      await carol.evaluate(() => (window as any).__SET_MEETING_SUB_OVERRIDES({ Alice: { audio: true, video: 'low', screen: false } }))
      await expect.poll(() => alice.evaluate(() => (window as any).__DEBUG_MEETING_VIDEO?.layers?.high?.active), { timeout: 15000 }).toBe(false)
      await expect.poll(async () => {
        const size = await remoteVideoSize(carol, 'Alice')
        return !!size && size.height > 0 && size.height <= 270
      }, { timeout: 15000 }).toBe(true)

      // Carol re-pins HD -> Alice restarts HD encoder with an immediate keyframe and Carol returns to 1280x720!
      await carol.evaluate(() => (window as any).__SET_MEETING_SUB_OVERRIDES({ Alice: { audio: true, video: 'high', screen: false } }))
      await expect.poll(() => alice.evaluate(() => (window as any).__DEBUG_MEETING_VIDEO?.layers?.high?.active), { timeout: 15000 }).toBe(true)
      await expect.poll(async () => remoteVideoSize(carol, 'Alice'), { timeout: 15000 }).toMatchObject({ width: 1280, height: 720 })

      const stats = await alice.evaluate(() => ({
        video: (window as any).__DEBUG_MEETING_VIDEO,
        transport: (window as any).__DEBUG_MEETING_TRANSPORT?.(),
      }))
      console.log('E2E_SIMULCAST_METRICS', JSON.stringify(stats))
    } finally {
      await Promise.all(contexts.map(c => c.close()))
    }
  })

  test('blind FIPS forwarder fans out 1x encrypted publisher upload to two real browsers and rotates keys on leave', async ({ browser }, testInfo) => {
    test.setTimeout(90000)
    const fipsPort = Number(process.env.PW_FIPS_PORT ?? 49320) + 1
    const seedUrl = `ws://127.0.0.1:${fipsPort}/fips`
    const sfuIdentity = await generateIdentity()
    const sfuPeer = canonicalPeer(toHex(sfuIdentity.publicKey))
    const sfuNode = new FipsNode({
      identity: sfuIdentity,
      transports: [new WebSocketTransport({ seedUrls: [seedUrl] })],
      routingMode: 'reply_learned',
    })
    let sfuSeedConnected = false
    sfuNode.on('peer', (event: any) => {
      if (event.state === 'connected') sfuSeedConnected = true
    })
    await sfuNode.start()
    await expect.poll(() => sfuSeedConnected, { timeout: 10000 }).toBe(true)

    const contexts = await Promise.all([0, 1, 2].map(() => browser.newContext({ permissions: ['camera', 'microphone'] })))
    let forwarderService: BlindForwarderService | undefined
    try {
      const [alice, bob, carol] = await Promise.all(contexts.map(c => c.newPage()))
      await alice.goto(`/?sfu=${sfuPeer}`)
      await alice.getByPlaceholder('Name').fill('Alice')
      await alice.getByRole('button', { name: 'Join', exact: true }).click()
      await alice.getByRole('button', { name: 'Start Meeting', exact: true }).click()
      await expect(alice.getByTitle('Leave meeting')).toBeVisible()

      // Derive ONLY the public room ID from the meeting hash (forwarder NEVER gets the URL secret or media keys!).
      const meetingUrl = new URL(alice.url())
      const secretHex = meetingUrl.hash.slice(1)
      const roomPubkey = getPublicKey(hexToBytes(secretHex))
      forwarderService = new BlindForwarderService({
        endpoint: sfuNode,
        room: roomPubkey.slice(0, 32),
      })

      const joinUrl = `${meetingUrl.origin}/?sfu=${sfuPeer}#${secretHex}`
      for (const [page, name] of [[bob, 'Bob'], [carol, 'Carol']] as const) {
        await page.goto(joinUrl)
        await page.getByPlaceholder('Name').fill(name)
        await page.getByRole('button', { name: 'Join Meeting', exact: true }).click()
        await expect(page.getByTitle('Leave meeting')).toBeVisible()
      }
      for (const page of [alice, bob, carol]) await connected(page, 2)

      // Wait for assisted mode via blind forwarder on all clients.
      for (const page of [alice, bob, carol]) {
        await expect.poll(() => page.evaluate(() => (window as any).__DEBUG_MEETING_TRANSPORT?.()?.mode), { timeout: 15000 }).toBe('assisted')
      }

      // Alice turns on camera & mic.
      await alice.getByTitle('Unmute microphone').click()
      await alice.getByTitle('Turn on camera').click()

      // Both Bob and Carol decode and render live 1280x720 HD video and audio from Alice!
      for (const page of [bob, carol]) {
        await expect.poll(async () => remoteVideoSize(page, 'Alice'), { timeout: 25000 }).toMatchObject({ width: 1280, height: 720 })
        await expect.poll(() => page.evaluate(() => ((window as any).__DEBUG_MEETING_MEDIA ?? []).some((s: any) => s.audio > 5 && s.energy > 0)), { timeout: 20000 }).toBe(true)
      }

      // Verify fan-out amplification: forwarder output packets must substantially exceed its input packets (~2x for 2 viewers).
      await expect.poll(() => {
        const st = forwarderService!.stats()
        return st.inPackets > 50 && st.outPackets >= Math.floor(st.inPackets * 1.5)
      }, { timeout: 15000 }).toBe(true)

      // Verify BIP-340 Schnorr origin commitments are verified end-to-end on receivers with zero forgeries.
      for (const page of [bob, carol]) {
        await expect.poll(() => page.evaluate(() => {
          const m = (window as any).__DEBUG_MEETING_TRANSPORT?.()
          return !!m && m.originVerified > 0 && m.originForged === 0
        }), { timeout: 15000 }).toBe(true)
      }

      const beforeLeave = await alice.evaluate(() => (window as any).__DEBUG_MEETING_TRANSPORT?.())
      const bobMetrics = await bob.evaluate(() => (window as any).__DEBUG_MEETING_TRANSPORT?.())
      const fwdStats = forwarderService.stats()
      console.log('E2E_BLIND_FORWARDER_METRICS', JSON.stringify({ alice: beforeLeave, bobOriginVerified: bobMetrics.originVerified, forwarder: fwdStats }))
      expect(beforeLeave.epoch).toBe(1)
      expect(beforeLeave.demand.videoHigh).toBe(true)
      expect(beforeLeave.demand.videoLow).toBe(false)
      // Verify publisher uploaded ~1x to forwarder (forwarder outPackets > 1.5x Alice's total uploaded packets).
      const aliceTotalUploadedPkts = beforeLeave.uploadedPackets[1] + beforeLeave.uploadedPackets[2] + beforeLeave.uploadedPackets[3] + beforeLeave.uploadedPackets[4]
      expect(fwdStats.outPackets).toBeGreaterThan(Math.floor(aliceTotalUploadedPkts * 1.5))

      await bob.screenshot({ path: testInfo.outputPath('blind-forwarder-bob-hd.png') })

      // Carol leaves -> Alice rotates media key epoch, and Bob continues receiving live video!
      const bobFramesBefore = (await remoteVideoSize(bob, 'Alice'))?.frames ?? 0
      await carol.getByTitle('Leave meeting').click()
      await expect.poll(() => alice.evaluate(() => (window as any).__DEBUG_MEETING_TRANSPORT?.()?.epoch), { timeout: 15000 }).toBeGreaterThan(beforeLeave.epoch)
      await expect.poll(async () => (await remoteVideoSize(bob, 'Alice'))?.frames ?? 0, { timeout: 15000 }).toBeGreaterThan(bobFramesBefore + 15)
    } finally {
      forwarderService?.close()
      await Promise.all(contexts.map(c => c.close()))
      await sfuNode.stop()
    }
  })

  test('pure P2P 5-browser room auto-upgrades to participant-run blind forwarding without any media server', async ({ browser }, testInfo) => {
    test.setTimeout(90000)
    const contexts = await Promise.all([0, 1, 2, 3, 4].map(() => browser.newContext({ permissions: ['camera', 'microphone'] })))
    try {
      const pages = await Promise.all(contexts.map(c => c.newPage()))
      const [alice, ...others] = pages
      await alice.goto('/')
      await alice.getByPlaceholder('Name').fill('Alice')
      await alice.getByRole('button', { name: 'Join', exact: true }).click()
      await alice.getByRole('button', { name: 'Start Meeting', exact: true }).click()
      await expect(alice.getByTitle('Leave meeting')).toBeVisible()
      const url = alice.url()

      for (const [idx, page] of others.entries()) {
        await page.goto(url)
        await page.getByPlaceholder('Name').fill(`Peer${idx + 2}`)
        await page.getByRole('button', { name: 'Join Meeting', exact: true }).click()
        await expect(page.getByTitle('Leave meeting')).toBeVisible()
      }

      // All 5 peers connect and automatically transition from mesh -> assisted (no SFU configured!).
      try {
        for (const page of pages) await connected(page, 4, 25000)
      } catch (err) {
        const snap = await Promise.all(pages.map((p, i) => p.evaluate(idx => ({
          idx,
          participants: [...((window as any).__DEBUG_PARTICIPANTS?.values() ?? [])].map((x: any) => ({ name: x.displayName, state: x.connectionState })),
          direct: [...((window as any).__DEBUG_DIRECT_PEERS?.keys() ?? [])].length,
          fipsErrors: (window as any).__DEBUG_FIPS_ERRORS?.slice(-10) ?? [],
          mode: (window as any).__DEBUG_MEETING_TRANSPORT?.()?.mode,
        }), i)))
        console.error('P2P_5BROWSER_TIMEOUT_SNAP', JSON.stringify(snap))
        throw err
      }
      for (const page of pages) {
        await expect.poll(() => page.evaluate(() => (window as any).__DEBUG_MEETING_TRANSPORT?.()?.mode), { timeout: 15000 }).toBe('assisted')
      }

      // Alice turns on camera & mic in a 5-person grid -> viewers subscribe thumbnail (low) by default,
      // and a participant peer automatically acts as a blind forwarder!
      await alice.getByTitle('Unmute microphone').click()
      await alice.getByTitle('Turn on camera').click()

      for (const page of others) {
        await expect.poll(async () => {
          const size = await remoteVideoSize(page, 'Alice')
          return !!size && size.height > 0 && size.height <= 270 && size.frames > 3
        }, { timeout: 25000 }).toBe(true)
      }

      // Verify at least one participant browser's embedded CallForwarder relayed encrypted packets!
      await expect.poll(async () => {
        const allStats = await Promise.all(pages.map(p => p.evaluate(() => (window as any).__DEBUG_MEETING_TRANSPORT?.()?.forwarderStats)))
        return allStats.some(st => st && st.inPackets > 10 && st.outPackets >= st.inPackets)
      }, { timeout: 15000 }).toBe(true)

      const aliceMetrics = await alice.evaluate(() => ({
        video: (window as any).__DEBUG_MEETING_VIDEO,
        transport: (window as any).__DEBUG_MEETING_TRANSPORT?.(),
      }))
      const helperStats = await Promise.all(pages.map(p => p.evaluate(() => (window as any).__DEBUG_MEETING_TRANSPORT?.()?.forwarderStats)))
      console.log('E2E_P2P_5BROWSER_METRICS', JSON.stringify({
        aliceHighEncoderActive: aliceMetrics.video.layers.high.active,
        aliceLowEncoderActive: aliceMetrics.video.layers.low.active,
        aliceUploadedPackets: aliceMetrics.transport.uploadedPackets,
        helperForwarderPackets: helperStats.map(s => ({ in: s?.inPackets ?? 0, out: s?.outPackets ?? 0 })),
      }))
      // Nobody pinned Alice in the 5-person grid -> Alice's HD encoder stayed completely OFF!
      expect(aliceMetrics.video.layers.high.active).toBe(false)
      expect(aliceMetrics.video.layers.low.active).toBe(true)
      await others[0].screenshot({ path: testInfo.outputPath('p2p-5browser-grid.png') })
    } finally {
      await Promise.all(contexts.map(c => c.close()))
    }
  })
})
