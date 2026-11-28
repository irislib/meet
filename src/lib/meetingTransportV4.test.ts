import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateIdentity, toHex } from '@fips/core'
import { MeetingTransport, canonicalPeer, type MeetingEndpoint, type TransportMediaFrame } from './meetingTransport'
import { BlindForwarderService } from './blindForwarderNode'
import {
  TRACK_AUDIO,
  TRACK_VIDEO_HIGH,
  TRACK_VIDEO_LOW,
  isCallV4Packet,
  type TrackId,
} from './callProtocolV4'

const room = 'ef'.repeat(16)

function meshNetwork() {
  const handlers = new Map<string, (packet: { src: string; peerId: string; payload: Uint8Array }) => void>()
  const wireLog: Array<{ src: string; dst: string; payload: Uint8Array }> = []
  let dropRule: ((src: string, dst: string, payload: Uint8Array) => boolean) | undefined

  const endpoint = (self: string): MeetingEndpoint => {
    const canonical = canonicalPeer(self)
    const peerId = canonical.slice(2)
    return {
      registerService(_port, handler) {
        handlers.set(peerId, handler)
        return () => { handlers.delete(peerId) }
      },
      async sendDatagram({ dst, payload }) {
        const dstCanonical = canonicalPeer(dst)
        wireLog.push({ src: canonical, dst: dstCanonical, payload })
        if (dropRule?.(canonical, dstCanonical, payload)) return
        handlers.get(dstCanonical.slice(2))?.({ src: canonical, peerId, payload })
      },
    }
  }
  return {
    endpoint,
    wireLog,
    setDropRule: (fn?: (src: string, dst: string, payload: Uint8Array) => boolean) => { dropRule = fn },
  }
}

afterEach(() => vi.useRealTimers())

describe('IC04 MeetingTransport: receiver-driven subscriptions, blind forwarding, and rekey', () => {
  it('Experiment 1 (direct): isolates throttled thumbnail viewer from HD viewer and stops HD encoder when unpinned', async () => {
    vi.useFakeTimers()
    const net = meshNetwork()
    const [aliceId, bobId, carolId] = await Promise.all([generateIdentity(), generateIdentity(), generateIdentity()])
    const alicePeer = canonicalPeer(toHex(aliceId.publicKey))
    const bobPeer = canonicalPeer(toHex(bobId.publicKey))
    const carolPeer = canonicalPeer(toHex(carolId.publicKey))

    const aliceKeyframes: Array<TrackId | undefined> = []
    const bobFrames: TransportMediaFrame[] = []
    const carolFrames: TransportMediaFrame[] = []

    const alice = new MeetingTransport(net.endpoint(alicePeer), room, {
      keyframe: trackId => aliceKeyframes.push(trackId),
    }, { identity: aliceId })
    const bob = new MeetingTransport(net.endpoint(bobPeer), room, {
      media: (_p, frame) => bobFrames.push(frame),
    }, { identity: bobId })
    const carol = new MeetingTransport(net.endpoint(carolPeer), room, {
      media: (_p, frame) => carolFrames.push(frame),
    }, { identity: carolId })

    try {
      alice.addPeer(bobPeer); alice.addPeer(carolPeer)
      bob.addPeer(alicePeer); bob.addPeer(carolPeer)
      carol.addPeer(alicePeer); carol.addPeer(bobPeer)
      alice.setState({ audioEnabled: true, videoEnabled: true, screenSharing: false })
      await vi.advanceTimersByTimeAsync(50)

      // Carol requests HD, Bob requests thumbnail (low).
      carol.setSubscriptionOverrides(new Map([[alicePeer, { audio: true, video: 'high', screen: false }]]))
      bob.setSubscriptionOverrides(new Map([[alicePeer, { audio: true, video: 'low', screen: false }]]))
      await vi.advanceTimersByTimeAsync(50)

      expect(alice.demand()).toMatchObject({ audio: true, videoLow: true, videoHigh: true })

      // Constrain Bob's link (drop 50% of video packets to Bob) while Carol stays healthy.
      let bobDrop = 0
      net.setDropRule((src, dst, payload) => src === alicePeer && dst === bobPeer && isCallV4Packet(payload) && (++bobDrop % 2 === 0))

      for (let seq = 0; seq < 15; seq++) {
        await alice.sendMedia({ kind: 2, trackId: TRACK_VIDEO_HIGH, key: seq === 0, seq, timestamp: seq * 33000, bytes: new Uint8Array(2500).fill(1) })
        await alice.sendMedia({ kind: 2, trackId: TRACK_VIDEO_LOW, key: seq === 0, seq, timestamp: seq * 66000, bytes: new Uint8Array(800).fill(2) })
      }
      await vi.advanceTimersByTimeAsync(1100)

      // Carol received all 15 HD frames and Alice's high layer stayed >= 1.2 Mbps,
      // while Alice's low layer adapted down independently for Bob!
      expect(carolFrames.filter(f => f.trackId === TRACK_VIDEO_HIGH)).toHaveLength(15)
      expect(alice.layerBitrates().high).toBeGreaterThanOrEqual(1_200_000)
      expect(alice.layerBitrates().low).toBeLessThan(260_000)

      // Carol unpins HD (switches to low) -> Alice's HD encoder demand turns OFF immediately!
      carol.setSubscriptionOverrides(new Map([[alicePeer, { audio: true, video: 'low', screen: false }]]))
      await vi.advanceTimersByTimeAsync(50)
      expect(alice.demand().videoHigh).toBe(false)
      expect(alice.demand().videoLow).toBe(true)

      // Carol re-pins HD -> Alice's HD encoder restarts AND gets an immediate keyframe request!
      aliceKeyframes.length = 0
      carol.setSubscriptionOverrides(new Map([[alicePeer, { audio: true, video: 'high', screen: false }]]))
      await vi.advanceTimersByTimeAsync(50)
      expect(alice.demand().videoHigh).toBe(true)
      expect(aliceKeyframes).toContain(TRACK_VIDEO_HIGH)
    } finally {
      await alice.close(); await bob.close(); await carol.close()
    }
  })

  it('Experiment 2 (blind forwarder): publisher uploads layer once for two viewers, payloads stay E2EE, and rekey revokes leaving peer', async () => {
    vi.useFakeTimers()
    const net = meshNetwork()
    const [aliceId, bobId, carolId, sfuId] = await Promise.all([
      generateIdentity(), generateIdentity(), generateIdentity(), generateIdentity(),
    ])
    const alicePeer = canonicalPeer(toHex(aliceId.publicKey))
    const bobPeer = canonicalPeer(toHex(bobId.publicKey))
    const carolPeer = canonicalPeer(toHex(carolId.publicKey))
    const sfuPeer = canonicalPeer(toHex(sfuId.publicKey))

    const sfu = new BlindForwarderService({ endpoint: net.endpoint(sfuPeer), room })
    const bobReceived: TransportMediaFrame[] = []
    const carolReceived: TransportMediaFrame[] = []

    const alice = new MeetingTransport(net.endpoint(alicePeer), room, {}, { identity: aliceId, dedicatedForwarder: sfuPeer })
    const bob = new MeetingTransport(net.endpoint(bobPeer), room, {
      media: (_p, f) => bobReceived.push(f),
    }, { identity: bobId, dedicatedForwarder: sfuPeer })
    const carol = new MeetingTransport(net.endpoint(carolPeer), room, {
      media: (_p, f) => carolReceived.push(f),
    }, { identity: carolId, dedicatedForwarder: sfuPeer })

    try {
      alice.addPeer(bobPeer); alice.addPeer(carolPeer)
      bob.addPeer(alicePeer); bob.addPeer(carolPeer)
      carol.addPeer(alicePeer); carol.addPeer(bobPeer)
      alice.setState({ audioEnabled: true, videoEnabled: true, screenSharing: false })
      await vi.advanceTimersByTimeAsync(100)

      // Both Bob and Carol subscribe to Alice's HD video through the blind forwarder.
      bob.setSubscriptionOverrides(new Map([[alicePeer, { audio: true, video: 'high', screen: false }]]))
      carol.setSubscriptionOverrides(new Map([[alicePeer, { audio: true, video: 'high', screen: false }]]))
      await vi.advanceTimersByTimeAsync(100)

      // Clear wire log before sending one 3000-byte HD keyframe from Alice.
      net.wireLog.length = 0
      const secretPayload = new TextEncoder().encode('TOP_SECRET_VIDEO_FRAME_' + 'X'.repeat(2980))
      await alice.sendMedia({ kind: 2, trackId: TRACK_VIDEO_HIGH, key: true, seq: 1, timestamp: 10000, bytes: secretPayload })
      await vi.advanceTimersByTimeAsync(50)

      // Publisher uploaded the 3 fragments ONCE (only to SFU, NEVER directly to Bob or Carol)!
      const aliceMediaOut = net.wireLog.filter(w => w.src === alicePeer && isCallV4Packet(w.payload))
      expect(aliceMediaOut).toHaveLength(3)
      expect(aliceMediaOut.every(w => w.dst === sfuPeer)).toBe(true)

      // Forwarder fanned out 3 fragments to Bob + 3 fragments to Carol = 6 packets total, without decrypting.
      const sfuMediaOut = net.wireLog.filter(w => w.src === sfuPeer && isCallV4Packet(w.payload))
      expect(sfuMediaOut).toHaveLength(6)
      for (const pkt of aliceMediaOut) {
        expect(new TextDecoder().decode(pkt.payload)).not.toContain('TOP_SECRET')
      }

      // Both Bob and Carol decrypted the exact plaintext!
      expect(bobReceived).toHaveLength(1)
      expect(carolReceived).toHaveLength(1)
      expect(bobReceived[0].bytes).toEqual(secretPayload)
      expect(carolReceived[0].bytes).toEqual(secretPayload)

      // Verify Carol leaving triggers epoch key rotation: even if Carol intercepts SFU packets, she cannot decrypt Epoch 2!
      const prevEpoch = alice.metrics().epoch
      alice.removePeer(carolPeer)
      expect(alice.metrics().epoch).toBe(prevEpoch + 1)

      const postLeavePayload = new TextEncoder().encode('POST_LEAVE_SECRET_AUDIO')
      net.wireLog.length = 0
      await alice.sendMedia({ kind: 1, trackId: TRACK_AUDIO, key: true, seq: 2, timestamp: 20000, bytes: postLeavePayload })
      await vi.advanceTimersByTimeAsync(50)

      // Bob decrypts post-leave Epoch 2 audio cleanly.
      expect(bobReceived.filter(f => f.trackId === TRACK_AUDIO)).toHaveLength(1)
      expect(bobReceived.find(f => f.trackId === TRACK_AUDIO)!.bytes).toEqual(postLeavePayload)

      // Even if a compromised forwarder still forwards Epoch 2 packets to Carol, Carol cannot decrypt them!
      const epoch2Pkt = net.wireLog.find(w => w.src === alicePeer && isCallV4Packet(w.payload))!.payload
      const beforeCarolCount = carolReceived.length
      await net.endpoint(sfuPeer).sendDatagram({ dst: carolPeer, srcPort: 39512, dstPort: 39512, payload: epoch2Pkt })
      expect(carolReceived).toHaveLength(beforeCarolCount)
    } finally {
      sfu.close()
      await alice.close(); await bob.close(); await carol.close()
    }
  })

  it('auto-downgrades only a losing viewer from high to low while healthy viewer keeps HD', async () => {
    vi.useFakeTimers()
    const net = meshNetwork()
    const [aliceId, bobId, carolId] = await Promise.all([generateIdentity(), generateIdentity(), generateIdentity()])
    const alicePeer = canonicalPeer(toHex(aliceId.publicKey))
    const bobPeer = canonicalPeer(toHex(bobId.publicKey))
    const carolPeer = canonicalPeer(toHex(carolId.publicKey))

    const bobFrames: TransportMediaFrame[] = []
    const carolFrames: TransportMediaFrame[] = []
    const alice = new MeetingTransport(net.endpoint(alicePeer), room, {}, { identity: aliceId })
    const bob = new MeetingTransport(net.endpoint(bobPeer), room, { media: (_p, f) => bobFrames.push(f) }, { identity: bobId, layerRecoveryMs: 3000 })
    const carol = new MeetingTransport(net.endpoint(carolPeer), room, { media: (_p, f) => carolFrames.push(f) }, { identity: carolId, layerRecoveryMs: 3000 })

    try {
      alice.addPeer(bobPeer); alice.addPeer(carolPeer)
      bob.addPeer(alicePeer); bob.addPeer(carolPeer)
      carol.addPeer(alicePeer); carol.addPeer(bobPeer)
      alice.setState({ audioEnabled: false, videoEnabled: true, screenSharing: false })
      await vi.advanceTimersByTimeAsync(100)

      // Both Bob and Carol start on high (small 3-person room).
      expect(alice.demand().videoHigh).toBe(true)
      expect(alice.demand().videoLow).toBe(false)

      // Drop 50% of video packets destined to Bob; Carol has 0% loss.
      let count = 0
      net.setDropRule((src, dst, payload) => src === alicePeer && dst === bobPeer && isCallV4Packet(payload) && (++count % 2 === 0))

      for (let seq = 0; seq < 20; seq++) {
        await alice.sendMedia({ kind: 2, trackId: TRACK_VIDEO_HIGH, key: seq === 0, seq, timestamp: seq * 33000, bytes: new Uint8Array(1500) })
      }
      await vi.advanceTimersByTimeAsync(1100)

      // Bob automatically downgraded himself to low -> Alice now serves low to Bob AND high to Carol!
      expect(alice.demand().videoLow).toBe(true)
      expect(alice.demand().videoHigh).toBe(true)

      // Verify Bob receives low frames while Carol continues receiving high frames!
      bobFrames.length = 0; carolFrames.length = 0
      net.setDropRule(undefined)
      for (let seq = 20; seq < 25; seq++) {
        await alice.sendMedia({ kind: 2, trackId: TRACK_VIDEO_HIGH, key: seq === 20, seq, timestamp: seq * 33000, bytes: new Uint8Array(1500) })
        await alice.sendMedia({ kind: 2, trackId: TRACK_VIDEO_LOW, key: seq === 20, seq, timestamp: seq * 66000, bytes: new Uint8Array(500) })
      }
      expect(bobFrames.every(f => f.trackId === TRACK_VIDEO_LOW)).toBe(true)
      expect(carolFrames.every(f => f.trackId === TRACK_VIDEO_HIGH)).toBe(true)

      // After sustained healthy reception (3s) while Carol continues receiving HD, Bob upgrades back to high and Alice stops low encoder!
      for (let sec = 0; sec < 4; sec++) {
        for (let i = 0; i < 15; i++) {
          const seq = 25 + sec * 15 + i
          await alice.sendMedia({ kind: 2, trackId: TRACK_VIDEO_HIGH, key: i === 0, seq, timestamp: seq * 33000, bytes: new Uint8Array(1500) })
          await alice.sendMedia({ kind: 2, trackId: TRACK_VIDEO_LOW, key: i === 0, seq, timestamp: seq * 66000, bytes: new Uint8Array(500) })
        }
        await vi.advanceTimersByTimeAsync(1000)
      }
      expect(alice.demand().videoHigh).toBe(true)
      expect(alice.demand().videoLow).toBe(false)
    } finally {
      await alice.close(); await bob.close(); await carol.close()
    }
  })

  it('converges a symmetric-NAT leaf onto assisted mode via direct-capable helpers without electing seed-only peers', async () => {
    vi.useFakeTimers()
    const net = meshNetwork()
    const ids = await Promise.all([0, 1, 2, 3, 4].map(() => generateIdentity()))
    const peers = ids.map(id => canonicalPeer(toHex(id.publicKey)))
    const [natLeafPeer, ...desktopPeers] = peers
    const desktopDirect = new Set(desktopPeers)
    const transports = peers.map((peer, idx) => new MeetingTransport(net.endpoint(peer), room, {}, {
      identity: ids[idx],
      // Peer 0 has zero direct WebRTC links (symmetric NAT / seed-only); peers 1..4 have direct links to each other.
      getDirectPeers: () => idx === 0 ? new Set() : new Set([...desktopDirect].filter(p => p !== peer)),
    }))
    try {
      for (let i = 0; i < peers.length; i++) {
        for (let j = 0; j < peers.length; j++) if (i !== j) transports[i].addPeer(peers[j])
      }
      await vi.advanceTimersByTimeAsync(200)
      for (const t of transports) {
        expect(t.metrics().mode).toBe('assisted')
        expect(t.metrics().eligibleHelpers).not.toContain(natLeafPeer)
        expect(t.metrics().eligibleHelpers.length).toBe(4)
      }
    } finally {
      await Promise.all(transports.map(t => t.close()))
    }
  })
})
