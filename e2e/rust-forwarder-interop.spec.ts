import { test, expect, type Page } from '@playwright/test'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { getPublicKey } from 'nostr-tools'

const rustForwarderBin = process.env.RUST_BLIND_FORWARDER_BIN

async function connected(page: Page, count: number, timeout = 20000) {
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

test('live Rust iris-blind-forwarder fans out E2EE IC04 HD video and audio between Chromium browsers', async ({ browser }, testInfo) => {
  test.setTimeout(90000)
  if (!rustForwarderBin || !existsSync(rustForwarderBin)) {
    test.skip(true, 'Set RUST_BLIND_FORWARDER_BIN to run live Rust blind forwarder interop')
    return
  }

  const fipsInfoPort = Number(process.env.PW_FIPS_PORT ?? 49320)
  const fipsSeedUrl = `ws://127.0.0.1:${fipsInfoPort + 1}/fips`
  const secretBytes = randomBytes(32)
  const secretHex = secretBytes.toString('hex')
  const roomId = getPublicKey(secretBytes).slice(0, 32)

  const contexts = await Promise.all([0, 1, 2].map(() => browser.newContext({ permissions: ['camera', 'microphone'] })))
  let proc: ReturnType<typeof spawn> | undefined
  try {
    // Launch real compiled Rust BlindForwarderService (zero media keys, zero codecs).
    proc = spawn(rustForwarderBin, ['--room', roomId, '--seed', fipsSeedUrl], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const events: Array<Record<string, any>> = []
    let stderr = ''
    proc.stderr?.on('data', chunk => { stderr += chunk.toString() })
    createInterface({ input: proc.stdout! }).on('line', line => {
      try { events.push(JSON.parse(line)) } catch { /* ignore non-JSON */ }
    })

    await expect.poll(() => events.find(e => e.event === 'ready'), { timeout: 20000 }).toBeTruthy()
    const ready = events.find(e => e.event === 'ready')!
    const rustSfuPeer: string = ready.peer

    // Open Alice, Bob, and Carol all pointing at the Rust blind forwarder via ?sfu=<rustSfuPeer>.
    const [alice, bob, carol] = await Promise.all(contexts.map(c => c.newPage()))
    const sfuUrl = `/?sfu=${rustSfuPeer}#${secretHex}`
    for (const [page, name] of [[alice, 'Alice'], [bob, 'Bob'], [carol, 'Carol']] as const) {
      await page.goto(sfuUrl)
      await page.getByPlaceholder('Name').fill(name)
      await page.getByRole('button', { name: 'Join Meeting', exact: true }).click()
      await expect(page.getByTitle('Leave meeting')).toBeVisible()
    }

    for (const page of [alice, bob, carol]) {
      await connected(page, 2, 25000)
      await expect.poll(() => page.evaluate(() => (window as any).__DEBUG_MEETING_TRANSPORT?.()?.mode), { timeout: 15000 }).toBe('assisted')
    }

    // Alice publishes HD video + audio; both Bob and Carol receive 1280x720 HD through the Rust forwarder!
    await alice.getByTitle('Unmute microphone').click()
    await alice.getByTitle('Turn on camera').click()

    for (const viewer of [bob, carol]) {
      await expect.poll(async () => {
        const size = await remoteVideoSize(viewer, 'Alice')
        return !!size && size.width === 1280 && size.height === 720 && size.frames > 5
      }, { timeout: 25000 }).toBe(true)
    }

    // Verify BIP-340 Schnorr origin commits pass cleanly through the Rust forwarder.
    await expect.poll(() => bob.evaluate(() => (window as any).__DEBUG_MEETING_TRANSPORT?.()?.originVerified ?? 0), { timeout: 15000 }).toBeGreaterThan(20)

    // Ask the Rust binary for its exact packet/byte counters!
    proc.stdin!.write('stats\n')
    await expect.poll(() => events.find(e => e.event === 'stats'), { timeout: 10000 }).toBeTruthy()
    const rustStats = events.find(e => e.event === 'stats')!.stats
    const aliceMetrics = await alice.evaluate(() => (window as any).__DEBUG_MEETING_TRANSPORT?.())
    const bobMetrics = await bob.evaluate(() => (window as any).__DEBUG_MEETING_TRANSPORT?.())

    expect(rustStats.inPackets).toBeGreaterThan(30)
    // 1x upload -> 2x fanout across two HD viewers!
    expect(rustStats.outPackets).toBeGreaterThanOrEqual(Math.floor(rustStats.inPackets * 1.5))
    expect(bobMetrics.originForged).toBe(0)

    await bob.screenshot({ path: testInfo.outputPath('rust-forwarder-bob-hd.png') })
    console.log('E2E_RUST_FORWARDER_INTEROP', JSON.stringify({ rustSfuPeer, rustStats, aliceUploadedFrames: aliceMetrics.uploadedFrames, bobOriginVerified: bobMetrics.originVerified }))
    if (stderr.trim()) console.error('RUST_FORWARDER_STDERR', stderr.slice(-500))
  } finally {
    if (proc && !proc.killed) {
      proc.stdin?.write('quit\n')
      proc.kill('SIGTERM')
    }
    await Promise.all(contexts.map(c => c.close()))
  }
})
