import { describe, expect, it, vi } from 'vitest'
import { generateIdentity, toHex } from '@fips/core'
import { CallForwarder } from './callForwarder'
import { CallTopology, type PeerCapability } from './callTopology'
import {
  CallV4Receiver,
  FLAG_DISCARDABLE,
  FLAG_ENCRYPTED,
  FLAG_KEYFRAME,
  TRACK_AUDIO,
  TRACK_VIDEO_HIGH,
  TRACK_VIDEO_LOW,
  computeRoomTag,
  encodeCallV4,
  senderTagFromPeer,
} from './callProtocolV4'
import { SenderKeyRing, openCallV4Frame, sealCallV4Frame } from './callCrypto'

const room = 'ab'.repeat(16)
const roomTag = computeRoomTag(room)

describe('blind selective forwarder (zero media keys)', () => {
  it('uploads once from publisher when two viewers subscribe to the same layer, and propagates HD stop upstream', async () => {
    const alice = await generateIdentity()
    const bob = await generateIdentity()
    const carol = await generateIdentity()
    const alicePeer = toHex(alice.publicKey)
    const bobPeer = toHex(bob.publicKey)
    const carolPeer = toHex(carol.publicKey)
    const aliceTag = senderTagFromPeer(alicePeer)

    const aliceRing = new SenderKeyRing(roomTag)
    const epoch1 = aliceRing.rotateLocalEpoch()
    const bobRing = new SenderKeyRing(roomTag)
    const carolRing = new SenderKeyRing(roomTag)
    bobRing.installRemoteKey(aliceTag, epoch1.epoch, epoch1.secret)
    carolRing.installRemoteKey(aliceTag, epoch1.epoch, epoch1.secret)

    const delivered = new Map<string, Uint8Array[]>([[bobPeer, []], [carolPeer, []]])
    const upstreamDemandChanges: Array<{ senderTag: number; tracks: number[] }> = []
    const forwarder = new CallForwarder({
      roomTag,
      maxSubscriberQueuePackets: 1,
      sendDatagram: async (dst, payload) => {
        delivered.get(dst)?.push(payload)
      },
      onUpstreamDemand: (senderTag, tracks) => {
        upstreamDemandChanges.push({ senderTag, tracks: [...tracks] })
      },
    })

    // Both Bob and Carol subscribe to Alice's audio + video_high.
    forwarder.setSubscriptions(bobPeer, [{ senderTag: aliceTag, tracks: [TRACK_AUDIO, TRACK_VIDEO_HIGH] }])
    forwarder.setSubscriptions(carolPeer, [{ senderTag: aliceTag, tracks: [TRACK_AUDIO, TRACK_VIDEO_HIGH] }])

    // Forwarder asks Alice for [audio, video_high] ONCE (union of subscribers).
    expect(forwarder.upstreamTracks(aliceTag)).toEqual([TRACK_AUDIO, TRACK_VIDEO_HIGH])

    // Alice encrypts ONE video_high frame (E2EE) and uploads it ONCE to the forwarder.
    const plaintext = new Uint8Array(3000).fill(0x5a)
    const header = {
      roomTag, senderTag: aliceTag, trackId: TRACK_VIDEO_HIGH,
      flags: FLAG_KEYFRAME | FLAG_ENCRYPTED, keyEpoch: epoch1.epoch, seq: 1, timestampUs: 10000,
    }
    const sealed = sealCallV4Frame(aliceRing.localMediaKey()!, header, plaintext)
    const packets = encodeCallV4({ ...header, payload: sealed })
    let publisherUploadPackets = 0
    for (const pkt of packets) {
      publisherUploadPackets++
      await forwarder.ingestDatagram(alicePeer, pkt, 100)
    }

    // Publisher uploaded the layer ONCE, forwarder delivered it to BOTH Bob and Carol (2x).
    expect(publisherUploadPackets).toBe(packets.length)
    expect(delivered.get(bobPeer)).toHaveLength(packets.length)
    expect(delivered.get(carolPeer)).toHaveLength(packets.length)

    // Neither packet contains plaintext; both Bob and Carol reassemble & decrypt cleanly.
    const bobRx = new CallV4Receiver(roomTag)
    const carolRx = new CallV4Receiver(roomTag)
    let bobFrame, carolFrame
    for (const pkt of delivered.get(bobPeer)!) bobFrame = bobRx.receive(pkt, 105)
    for (const pkt of delivered.get(carolPeer)!) carolFrame = carolRx.receive(pkt, 105)
    expect(openCallV4Frame(bobRing.remoteMediaKey(aliceTag, epoch1.epoch)!, bobFrame!, bobFrame!.payload)).toEqual(plaintext)
    expect(openCallV4Frame(carolRing.remoteMediaKey(aliceTag, epoch1.epoch)!, carolFrame!, carolFrame!.payload)).toEqual(plaintext)

    // Bob switches to low, Carol hides HD -> upstream demand drops video_high completely!
    forwarder.setSubscriptions(bobPeer, [{ senderTag: aliceTag, tracks: [TRACK_AUDIO, TRACK_VIDEO_LOW] }])
    forwarder.setSubscriptions(carolPeer, [{ senderTag: aliceTag, tracks: [TRACK_AUDIO, TRACK_VIDEO_LOW] }])
    expect(forwarder.upstreamTracks(aliceTag)).toEqual([TRACK_AUDIO, TRACK_VIDEO_LOW])
    expect(upstreamDemandChanges[upstreamDemandChanges.length - 1]).toEqual({
      senderTag: aliceTag,
      tracks: [TRACK_AUDIO, TRACK_VIDEO_LOW],
    })
  })

  it('serves local NACK retransmissions from cache, coalesces keyframe storms, and prioritizes audio over discardable video', async () => {
    const alicePeer = `02${'11'.repeat(32)}`
    const bobPeer = `02${'22'.repeat(32)}`
    const carolPeer = `02${'33'.repeat(32)}`
    const aliceTag = senderTagFromPeer(alicePeer)

    const sent: Array<{ dst: string; payload: Uint8Array }> = []
    let releaseSlow!: () => void
    let stallBob = false
    const keyframeUpstream = vi.fn()

    const forwarder = new CallForwarder({
      roomTag,
      maxSubscriberQueuePackets: 1,
      sendDatagram: async (dst, payload) => {
        if (dst === bobPeer && stallBob) {
          stallBob = false
          await new Promise<void>(resolve => { releaseSlow = resolve })
        }
        sent.push({ dst, payload })
      },
      onKeyframeNeeded: keyframeUpstream,
    })

    forwarder.setSubscriptions(bobPeer, [{ senderTag: aliceTag, tracks: [TRACK_AUDIO, TRACK_VIDEO_HIGH] }])
    forwarder.setSubscriptions(carolPeer, [{ senderTag: aliceTag, tracks: [TRACK_AUDIO, TRACK_VIDEO_HIGH] }])

    const videoPkts = encodeCallV4({
      roomTag, senderTag: aliceTag, trackId: TRACK_VIDEO_HIGH,
      flags: FLAG_KEYFRAME, keyEpoch: 1, seq: 10, timestampUs: 1000,
      payload: new Uint8Array(2500).fill(3),
    })
    for (const p of videoPkts) await forwarder.ingestDatagram(alicePeer, p, 100)

    // Local NACK served directly from forwarder cache without touching Alice.
    sent.length = 0
    const repaired = await forwarder.handleNack(bobPeer, { senderTag: aliceTag, trackId: TRACK_VIDEO_HIGH, seq: 10, missing: [1] }, 150)
    expect(repaired).toBe(1)
    expect(sent).toHaveLength(1)
    expect(sent[0].dst).toBe(bobPeer)
    expect(forwarder.stats().nacksServedLocally).toBe(1)

    // Coalesce 5 simultaneous keyframe requests within 500ms into 1 upstream request.
    for (let i = 0; i < 5; i++) forwarder.handleKeyframeRequest(aliceTag, TRACK_VIDEO_HIGH, 200 + i * 20)
    expect(keyframeUpstream).toHaveBeenCalledTimes(1)
    expect(forwarder.stats().keyframesCoalesced).toBe(4)
    forwarder.handleKeyframeRequest(aliceTag, TRACK_VIDEO_HIGH, 800)
    expect(keyframeUpstream).toHaveBeenCalledTimes(2)

    // Under backpressure on Bob: discardable video drops, audio STILL gets through, Carol unaffected!
    sent.length = 0
    stallBob = true
    const delta1 = encodeCallV4({
      roomTag, senderTag: aliceTag, trackId: TRACK_VIDEO_HIGH, flags: 0,
      keyEpoch: 1, seq: 11, timestampUs: 2000, payload: new Uint8Array(200),
    })[0]
    const inflight = forwarder.ingestDatagram(alicePeer, delta1, 900)
    await Promise.resolve()

    const discardable = encodeCallV4({
      roomTag, senderTag: aliceTag, trackId: TRACK_VIDEO_HIGH, flags: FLAG_DISCARDABLE,
      keyEpoch: 1, seq: 12, timestampUs: 3000, payload: new Uint8Array(200),
    })[0]
    const audio = encodeCallV4({
      roomTag, senderTag: aliceTag, trackId: TRACK_AUDIO, flags: 0,
      keyEpoch: 1, seq: 1, timestampUs: 3000, payload: new Uint8Array(40),
    })[0]
    await forwarder.ingestDatagram(alicePeer, discardable, 905)
    await forwarder.ingestDatagram(alicePeer, audio, 906)

    // Audio reached Bob immediately even while Bob's video queue was stalled; discardable dropped for Bob but reached Carol!
    expect(sent.filter(s => s.dst === bobPeer)).toHaveLength(1)
    expect(sent.filter(s => s.dst === carolPeer)).toHaveLength(3) // delta1 + discardable + audio
    expect(forwarder.stats().droppedDiscardable).toBe(1)

    releaseSlow()
    await inflight
  })
})

describe('route-aware P2P topology and helper election', () => {
  const cap = (peer: string, overrides: Partial<PeerCapability> = {}): PeerCapability => ({
    peer,
    direct: true,
    rttMs: 25,
    uplinkKbps: 20_000,
    mobile: false,
    background: false,
    dedicated: false,
    maxFanout: 6,
    ...overrides,
  })

  it('uses direct mesh for small rooms (<=4) and excludes seed-relayed, mobile, or background peers as helpers', () => {
    const topo = new CallTopology('self')
    topo.updateCapability(cap('self', { uplinkKbps: 50_000 }))
    topo.updateCapability(cap('p1', { direct: false, uplinkKbps: 100_000 })) // seed detour -> must NOT be elected!
    topo.updateCapability(cap('p2', { mobile: true, uplinkKbps: 50_000 }))   // phone -> must NOT be elected!
    topo.updateCapability(cap('p3', { background: true, uplinkKbps: 50_000 })) // hidden tab -> must NOT be elected!
    expect(topo.mode()).toBe('mesh')
    expect(topo.eligibleHelpers()).toEqual(['self'])
  })

  it('upgrades to assisted depth-2 helpers in larger rooms, shards tracks across helpers, and promotes warm standby on failure', () => {
    const topo = new CallTopology('p0')
    topo.updateCapability(cap('p0', { uplinkKbps: 5_000, maxFanout: 2 }))
    topo.updateCapability(cap('desktop1', { uplinkKbps: 80_000, rttMs: 15, maxFanout: 10 }))
    topo.updateCapability(cap('desktop2', { uplinkKbps: 60_000, rttMs: 20, maxFanout: 10 }))
    topo.updateCapability(cap('leaf1', { mobile: true, uplinkKbps: 2_000, maxFanout: 0 }))
    topo.updateCapability(cap('leaf2', { mobile: true, uplinkKbps: 2_000, maxFanout: 0 }))
    topo.updateCapability(cap('leaf3', { direct: false, uplinkKbps: 40_000, maxFanout: 6 }))

    expect(topo.mode()).toBe('assisted')
    expect(topo.eligibleHelpers()).toEqual(['desktop1', 'desktop2', 'p0'])

    // Route selection assigns a primary + warm standby helper, and never picks the sender itself as its own helper.
    const route = topo.routeForSender('leaf1', 101)
    expect(route.primary).toBeDefined()
    expect(route.standby).toBeDefined()
    expect(route.primary).not.toBe(route.standby)
    expect(route.primary).not.toBe('leaf1')

    // Failing the primary helper promotes standby deterministically.
    const oldPrimary = route.primary!
    topo.markHelperUnhealthy(oldPrimary, 1000)
    const failover = topo.routeForSender('leaf1', 101, 1500)
    expect(failover.primary).toBe(route.standby)
  })

  it('prefers dedicated blind forwarders when present and balances listeners across helpers in stage mode', () => {
    const topo = new CallTopology('listener1')
    topo.updateCapability(cap('presenter', { uplinkKbps: 10_000, maxFanout: 4 }))
    topo.updateCapability(cap('sfu1', { dedicated: true, direct: true, uplinkKbps: 500_000, maxFanout: 100 }))
    topo.updateCapability(cap('desktop1', { uplinkKbps: 50_000, maxFanout: 8 }))
    expect(topo.mode()).toBe('assisted')
    expect(topo.routeForSender('presenter', 1).primary).toBe('sfu1')

    // Pure P2P stage mode (no dedicated SFU): 1 presenter + 3 desktop helpers + 15 listeners -> listeners distributed across helpers!
    const stage = new CallTopology('presenter')
    stage.updateCapability(cap('presenter', { uplinkKbps: 8_000, maxFanout: 4 }))
    for (const h of ['h1', 'h2', 'h3']) stage.updateCapability(cap(h, { uplinkKbps: 50_000, maxFanout: 8 }))
    for (let i = 0; i < 15; i++) stage.updateCapability(cap(`L${i}`, { mobile: true, maxFanout: 0 }))

    const assigned = new Map<string, number>()
    for (let i = 0; i < 15; i++) {
      const parent = stage.stageHelperForListener('presenter', `L${i}`)
      expect(['h1', 'h2', 'h3']).toContain(parent)
      assigned.set(parent!, (assigned.get(parent!) ?? 0) + 1)
    }
    // Evenly balanced across the 3 helpers (5 listeners each).
    expect([...assigned.values()].every(count => count >= 4 && count <= 6)).toBe(true)
  })
})
