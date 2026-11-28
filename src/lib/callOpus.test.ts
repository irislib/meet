import { expect, it } from 'vitest'
import { CallOpus, isDtxPacket } from './callOpus'

it('bundled Opus encodes speech-sized packets, decodes audio and conceals a lost packet', async () => {
  const codec = await CallOpus.open()
  let energy = 0
  for (let frame = 0; frame < 10; frame++) {
    const pcm = Float32Array.from({ length: 960 }, (_, i) => .3 * Math.sin((frame * 960 + i) * 2 * Math.PI * 440 / 48000))
    const packet = codec.encode(pcm)
    expect(packet.length).toBeGreaterThan(2)
    expect(isDtxPacket(packet)).toBe(false)
    expect(packet.length).toBeLessThanOrEqual(1275)
    const decoded = codec.decode(packet)!
    expect(decoded.length).toBe(960)
    energy += decoded.reduce((sum, value) => sum + value * value, 0)
  }
  expect(energy).toBeGreaterThan(1)
  const concealed = codec.decode()!
  expect(concealed.length).toBe(960)
  expect(concealed.some(sample => sample !== 0)).toBe(true)
  codec.close()
  expect(codec.decode()).toBeUndefined()
})

it('suppresses silent frames via Opus DTX and resumes speech cleanly', async () => {
  const codec = await CallOpus.open()
  const decoder = await CallOpus.open()
  try {
    const silence = new Float32Array(960)
    let transmitted = 0
    let suppressed = 0
    // Encode 3 seconds (150 frames) of silence: after initial comfort-noise frames, DTX suppresses >80%.
    for (let i = 0; i < 150; i++) {
      const packet = codec.encode(silence)
      if (isDtxPacket(packet)) suppressed++
      else transmitted++
    }
    expect(suppressed).toBeGreaterThan(100)
    expect(transmitted).toBeLessThan(50)

    // Resuming speech produces full packets that decode with strong energy even after skipped DTX frames.
    let resumedEnergy = 0
    for (let i = 0; i < 10; i++) {
      const pcm = Float32Array.from({ length: 960 }, (_, s) => .3 * Math.sin((i * 960 + s) * 2 * Math.PI * 440 / 48000))
      const packet = codec.encode(pcm)
      expect(isDtxPacket(packet)).toBe(false)
      const out = decoder.decode(packet)!
      resumedEnergy += out.reduce((sum, v) => sum + v * v, 0)
    }
    expect(resumedEnergy).toBeGreaterThan(1)
  } finally {
    codec.close()
    decoder.close()
  }
})
