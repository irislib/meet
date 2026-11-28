import { describe, expect, it } from 'vitest'
import { CallMediaReceiver, encodeCallMedia, MAX_AUDIO_BYTES, MAX_VIDEO_BYTES } from './callProtocol'

const room = 'ab'.repeat(16)

describe('call media protocol', () => {
  it('round-trips single-chunk audio and multi-chunk out-of-order video frames', () => {
    const receiver = new CallMediaReceiver()
    const audio = { kind: 1 as const, seq: 7, timestamp: 20000, key: true, bytes: new Uint8Array([1, 2, 3, 4, 5]) }
    const audioPackets = encodeCallMedia(room, audio)
    expect(audioPackets).toHaveLength(1)
    expect(receiver.receive(room, audioPackets[0], 10)).toEqual(audio)
    // Duplicate frame is dropped.
    expect(receiver.receive(room, audioPackets[0], 20)).toBeNull()

    const videoBytes = Uint8Array.from({ length: 4000 }, (_, i) => i & 0xff)
    const video = { kind: 2 as const, seq: 42, timestamp: 66666, key: true, bytes: videoBytes }
    const packets = encodeCallMedia(room, video)
    expect(packets.length).toBe(4)
    expect(receiver.receive(room, packets[3], 30)).toBeNull()
    expect(receiver.receive(room, packets[1], 31)).toBeNull()
    expect(receiver.receive(room, packets[0], 32)).toBeNull()
    // Duplicate chunk is ignored.
    expect(receiver.receive(room, packets[1], 33)).toBeNull()
    expect(receiver.receive(room, packets[2], 34)).toEqual(video)
    expect(receiver.highestVideo).toBe(42)
  })

  it('rejects wrong rooms, oversized payloads, and expired partials', () => {
    const receiver = new CallMediaReceiver()
    expect(encodeCallMedia('bad', { kind: 1, seq: 0, timestamp: 0, key: true, bytes: new Uint8Array(10) })).toEqual([])
    expect(encodeCallMedia(room, { kind: 1, seq: 0, timestamp: 0, key: true, bytes: new Uint8Array(MAX_AUDIO_BYTES + 1) })).toEqual([])
    expect(encodeCallMedia(room, { kind: 2, seq: 0, timestamp: 0, key: true, bytes: new Uint8Array(MAX_VIDEO_BYTES + 1) })).toEqual([])

    const packets = encodeCallMedia(room, { kind: 2, seq: 1, timestamp: 1000, key: true, bytes: new Uint8Array(2500).fill(9) })
    expect(receiver.receive('cd'.repeat(16), packets[0], 0)).toBeNull()
    expect(receiver.receive(room, packets[0], 0)).toBeNull()
    // After 250ms, the incomplete partial expires so the remaining fragments cannot complete it.
    expect(receiver.receive(room, packets[1], 300)).toBeNull()
    expect(receiver.receive(room, packets[2], 301)).toBeNull()
  })
})
