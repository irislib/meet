import { test, expect } from '@playwright/test'

test('participant state updates keep the receiving video playing', async ({ browser }, testInfo) => {
  const contexts = await Promise.all([0, 1].map(() => browser.newContext({ permissions: ['camera', 'microphone'] })))
  try {
    const [sender, receiver] = await Promise.all(contexts.map(context => context.newPage()))
    await sender.goto('/')
    await sender.getByRole('button', { name: 'Join', exact: true }).click()
    await sender.getByRole('button', { name: 'Start Meeting', exact: true }).click()
    await expect(sender.getByText('(You)')).toBeVisible()
    await receiver.goto(sender.url())
    await receiver.getByRole('button', { name: 'Join Meeting', exact: true }).click()
    await expect(receiver.getByTestId('video-tile')).toHaveCount(2)
    await sender.getByTitle('Turn on camera').click()
    const video = receiver.locator('video').filter({ visible: true })
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(10)
    await video.evaluate((element: HTMLVideoElement) => {
      const observation = (window as any).__PLAYBACK = { emptied: 0, metadata: 0, element, stream: element.srcObject }
      element.addEventListener('emptied', () => { observation.emptied++ })
      element.addEventListener('loadedmetadata', () => { observation.metadata++ })
    })
    // Remote microphone state and the periodic hello use the same participant
    // update path. Neither changes this video element's existing MediaStream.
    for (const enabled of [true, false]) {
      await sender.getByTitle(enabled ? 'Unmute microphone' : 'Mute microphone', { exact: false }).click()
      await expect.poll(() => receiver.evaluate(() => [...(window as any).__DEBUG_PARTICIPANTS.values()][0]?.audioEnabled)).toBe(enabled)
    }
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(30)
    expect(await video.evaluate(element => {
      const observation = (window as any).__PLAYBACK
      return { emptied: observation.emptied, metadata: observation.metadata, sameElement: element === observation.element, sameStream: (element as HTMLVideoElement).srcObject === observation.stream }
    })).toEqual({ emptied: 0, metadata: 0, sameElement: true, sameStream: true })
    // Sustain playback through several five-second hello exchanges and a
    // fifteen-second room presence announcement, without arbitrary sleeps.
    await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.getVideoPlaybackQuality().totalVideoFrames), { timeout: 25000 }).toBeGreaterThan(480)
    expect(await receiver.evaluate(() => {
      const { emptied, metadata } = (window as any).__PLAYBACK
      return { emptied, metadata }
    })).toEqual({ emptied: 0, metadata: 0 })
    await receiver.screenshot({ path: testInfo.outputPath('continuous-video.png') })
  } finally { await Promise.all(contexts.map(context => context.close())) }
})
