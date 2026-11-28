import { fromHex, toHex, type FipsIdentity } from '@fips/core'
import { CallMediaReceiver, encodeCallMedia, type MediaFrame } from './callProtocol'
import { CallAdaptation } from './callAdaptation'
import { LAYER_PROFILES, callEncoding } from './callQuality'
import {
  CallV4Receiver,
  FLAG_DISCARDABLE,
  FLAG_ENCRYPTED,
  FLAG_KEYFRAME,
  TRACK_AUDIO,
  TRACK_SCREEN,
  TRACK_VIDEO_HIGH,
  TRACK_VIDEO_LOW,
  computeRoomTag,
  encodeCallV4,
  isCallV4Packet,
  isValidTrackId,
  peekCallV4Header,
  roomTagsEqual,
  senderTagFromPeer,
  type CallV4Nack,
  type TrackId,
} from './callProtocolV4'
import {
  OriginCommitSigner,
  OriginCommitVerifier,
  SenderKeyRing,
  openCallV4Frame,
  sealCallV4Frame,
  unwrapSenderKey,
  wrapSenderKey,
  type OriginCommitMessage,
} from './callCrypto'
import {
  ReceiverLayerGuard,
  aggregatePublisherDemand,
  computeViewportSubscriptions,
  subscriptionToTracks,
  subscriptionsEqual,
  tracksToSubscription,
  type PeerSubscription,
  type VideoLayer,
} from './callSubscriptions'
import { CallForwarder, type CallForwarderStats, type ForwarderSubscriptionEntry } from './callForwarder'
import { CallTopology, type CallTopologyMode, type PeerCapability } from './callTopology'

export const MEETING_PORT = 39512
export const canonicalPeer = (address: string) => /^(02|03)[a-f0-9]{64}$/.test(address) ? `02${address.slice(2)}` : ''
export function authenticatedMeetingPeer(address: string, peerId?: string) {
  return peerId === undefined ? canonicalPeer(address) : canonicalPeer(`02${peerId}`)
}
export interface MeetingEndpoint {
  registerService(port: number, handler: (packet: { src: string; peerId?: string; payload: Uint8Array }) => void): () => void
  sendDatagram(packet: { dst: string; srcPort: number; dstPort: number; payload: Uint8Array }): Promise<void>
}
export interface MediaState { audioEnabled: boolean; videoEnabled: boolean; screenSharing: boolean }
export interface TransportChat { id: string; text: string; timestamp: number }
export interface TransportMediaFrame extends MediaFrame {
  trackId?: TrackId
  discardable?: boolean
}
export interface MediaDemand {
  audio: boolean
  videoLow: boolean
  videoHigh: boolean
  screen: boolean
}
export interface LayerBitrates {
  low: number
  high: number
  screen: number
}
export interface TransportMetrics {
  v4: boolean
  mode: CallTopologyMode
  epoch: number
  dedicatedForwarder: string | null
  eligibleHelpers: string[]
  directPeerCount: number
  activeHelpers: Record<string, string | undefined>
  uploadedPackets: Record<TrackId, number>
  uploadedBytes: Record<TrackId, number>
  uploadedFrames: Record<TrackId, number>
  receivedFrames: Record<TrackId, number>
  nacksSent: number
  nacksServed: number
  originVerified: number
  originForged: number
  demand: MediaDemand
  bitrates: LayerBitrates
  forwarderStats: CallForwarderStats | null
}
export interface MeetingTransportOptions {
  identity?: FipsIdentity
  dedicatedForwarder?: string
  maxVideoDecoders?: number
  enableHelperRole?: boolean
  mobile?: boolean
  background?: boolean
  uplinkKbps?: number
  maxFanout?: number
  layerRecoveryMs?: number
  getDirectPeers?: () => ReadonlySet<string>
}
interface Callbacks {
  heartbeat?(peer: string): void
  connected?(peer: string): void
  failed?(peer: string): void
  leave?(peer: string): void
  message?(peer: string, message: TransportChat): void
  state?(peer: string, state: MediaState): void
  media?(peer: string, frame: TransportMediaFrame): void
  keyframe?(trackId?: TrackId): void
  bitrate?(bitsPerSecond: number): void
  layerBitrates?(bitrates: LayerBitrates): void
  demand?(demand: MediaDemand): void
  originForgery?(senderPeer: string, viaPeer: string): void
  error?(message: string): void
}

interface TrackFeedbackState {
  adaptation: CallAdaptation
  sending: boolean
  receivedFrames: number
  receivedBytes: number
  feedbackAt: number
  feedbackSequence: number
  subscribedAt: number
  lastHighest?: number
}

interface Peer {
  receiver: CallMediaReceiver
  heard: number
  connected: boolean
  failed: boolean
  initiateAfter: number
  v4: boolean
  remoteAudio: boolean
  remoteVideo: boolean
  remoteScreen: boolean
  seen: Set<string>
  // Legacy IC03 adaptation
  adaptation: CallAdaptation
  videoSending: boolean
  feedbackAt: number
  feedbackSequence: number
  receivedFrames: number
  receivedBytes: number
  pendingKey?: { packets: Uint8Array[]; allowed: () => boolean }
  // IC04 per-track adaptation, subscription, and route telemetry
  tracks: Record<2 | 3 | 4, TrackFeedbackState>
  remoteSub: PeerSubscription
  localSub: PeerSubscription
  lastMediaVia?: string
  pingSentAt?: number
  rttMs: number
  ackedKeyEpoch: number
  lastKeyReqAt: number
  wasLocalDirect: boolean
  remoteCap: { direct: boolean; uplinkKbps: number; mobile: boolean; background: boolean; maxFanout: number }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function makeTrackFeedback(cap: number, defaultTarget: number, now: number, minBitrate = 100_000): TrackFeedbackState {
  const adaptation = new CallAdaptation(cap, now, minBitrate)
  adaptation.target = Math.min(cap, defaultTarget)
  return {
    adaptation,
    sending: false,
    receivedFrames: 0,
    receivedBytes: 0,
    feedbackAt: now,
    feedbackSequence: 0,
    subscribedAt: now,
  }
}

/**
 * Group call transport over authenticated FIPS datagrams.
 * Supports legacy IC03 mesh and IC04 SFrame-E2EE multi-track receiver-driven subscriptions
 * with embedded desktop helper forwarding or standalone blind FIPS forwarders.
 */
export class MeetingTransport {
  private peers = new Map<string, Peer>()
  private tagToPeer = new Map<number, string>()
  private pending = new Map<string, { payload: Uint8Array; waiting: Set<string>; expires: number }>()
  private state: MediaState = { audioEnabled: false, videoEnabled: false, screenSharing: false }
  private stopped = false
  private unregister: () => void
  private timer: ReturnType<typeof setInterval>
  private nackTimer?: ReturnType<typeof setInterval>
  private tickCount = 0
  private mediaBusy = new Set<string>()
  private pendingV4Keys = new Map<string, { packets: Uint8Array[]; allowed: () => boolean }>()
  private targetBitrate = 1_200_000
  private bitrates: LayerBitrates = {
    low: LAYER_PROFILES.low.defaultBitrate,
    high: LAYER_PROFILES.high.defaultBitrate,
    screen: LAYER_PROFILES.screen.defaultBitrate,
  }
  private currentDemand: MediaDemand = { audio: false, videoLow: false, videoHigh: false, screen: false }

  // IC04 E2EE, subscriptions, and forwarding state
  private readonly identity?: FipsIdentity
  private readonly v4Enabled: boolean
  private readonly roomTag: Uint8Array
  private readonly localPeer: string
  private readonly localTag: number
  private readonly keyRing?: SenderKeyRing
  private readonly originSigner?: OriginCommitSigner
  private readonly originVerifier?: OriginCommitVerifier
  private readonly v4Receiver?: CallV4Receiver
  private readonly layerGuard: ReceiverLayerGuard
  private readonly topology?: CallTopology
  private readonly embeddedForwarder?: CallForwarder
  private readonly getDirectPeers?: () => ReadonlySet<string>
  private readonly maxVideoDecoders: number
  private readonly mobile: boolean
  private background: boolean
  private readonly uplinkKbps: number
  private readonly maxFanout: number
  private dedicatedForwarder: string | null = null
  private dedicatedReady = false
  private focusedPeer: string | null = null
  private subscriptionOverrides?: ReadonlyMap<string, Partial<PeerSubscription>>
  // forwarderPeer -> Set<TrackId> currently demanded from our local publisher
  private forwarderDemand = new Map<string, Set<TrackId>>()
  // forwarderPeer -> last sent ForwarderSubscriptionEntry[] JSON (to avoid redundant sends)
  private lastForwarderSubSent = new Map<string, string>()
  private lastForwarderEntries = new Map<string, ForwarderSubscriptionEntry[]>()
  private lastDirectSubSent = new Map<string, string>()
  // Local 250ms retransmit cache for direct NACK recovery: "trackId:seq" -> { at, packets }
  private retransmitCache = new Map<string, { at: number; packets: Uint8Array[]; bytes: number }>()
  private retransmitBytes = 0
  private lastOriginFlushAt = 0

  private uploadedPackets: Record<TrackId, number> = { 1: 0, 2: 0, 3: 0, 4: 0 }
  private uploadedBytes: Record<TrackId, number> = { 1: 0, 2: 0, 3: 0, 4: 0 }
  private uploadedFrames: Record<TrackId, number> = { 1: 0, 2: 0, 3: 0, 4: 0 }
  private receivedFrames: Record<TrackId, number> = { 1: 0, 2: 0, 3: 0, 4: 0 }
  private nacksSent = 0
  private nacksServed = 0
  private originVerified = 0
  private originForged = 0

  get videoBitrate() { return this.targetBitrate }
  layerBitrates(): LayerBitrates { return { ...this.bitrates } }
  demand(): MediaDemand { return { ...this.currentDemand } }

  metrics(): TransportMetrics {
    const activeHelpers: Record<string, string | undefined> = {}
    if (this.topology) {
      for (const peer of this.peers.keys()) {
        const route = this.topology.routeForSender(peer, senderTagFromPeer(peer))
        if (route.primary) activeHelpers[peer] = route.primary
      }
      const selfRoute = this.topology.routeForSender(this.localPeer, this.localTag)
      if (selfRoute.primary) activeHelpers[this.localPeer] = selfRoute.primary
    }
    return {
      v4: this.v4Enabled,
      mode: this.topology?.mode() ?? 'mesh',
      epoch: this.keyRing?.currentEpoch ?? 0,
      dedicatedForwarder: this.dedicatedForwarder,
      eligibleHelpers: this.topology?.eligibleHelpers() ?? [],
      directPeerCount: this.getDirectPeers?.().size ?? 0,
      activeHelpers,
      uploadedPackets: { ...this.uploadedPackets },
      uploadedBytes: { ...this.uploadedBytes },
      uploadedFrames: { ...this.uploadedFrames },
      receivedFrames: { ...this.receivedFrames },
      nacksSent: this.nacksSent,
      nacksServed: this.nacksServed,
      originVerified: this.originVerified,
      originForged: this.originForged,
      demand: { ...this.currentDemand },
      bitrates: { ...this.bitrates },
      forwarderStats: this.embeddedForwarder?.stats() ?? null,
    }
  }

  constructor(
    private endpoint: MeetingEndpoint,
    private room: string,
    private callbacks: Callbacks,
    options: MeetingTransportOptions = {},
  ) {
    this.identity = options.identity
    this.v4Enabled = !!options.identity
    this.roomTag = computeRoomTag(room)
    this.localPeer = options.identity ? canonicalPeer(toHex(options.identity.publicKey)) : ''
    this.localTag = this.localPeer ? senderTagFromPeer(this.localPeer) : 0
    this.getDirectPeers = options.getDirectPeers
    this.mobile = options.mobile ?? false
    this.background = options.background ?? false
    this.maxVideoDecoders = options.maxVideoDecoders ?? (this.mobile ? 4 : 9)
    this.uplinkKbps = options.uplinkKbps ?? (this.mobile ? 4_000 : 30_000)
    this.maxFanout = options.maxFanout ?? (this.mobile ? 0 : 8)
    this.layerGuard = new ReceiverLayerGuard({ recoverHealthyMs: options.layerRecoveryMs ?? 6000 })

    if (this.identity && this.localPeer) {
      this.keyRing = new SenderKeyRing(this.roomTag)
      this.keyRing.rotateLocalEpoch()
      this.originSigner = new OriginCommitSigner(this.identity, this.roomTag, this.localTag)
      this.originVerifier = new OriginCommitVerifier(this.roomTag)
      this.v4Receiver = new CallV4Receiver(this.roomTag)
      this.topology = new CallTopology(this.localPeer)
      this.topology.updateCapability(this.localCapability())

      if (options.enableHelperRole !== false && !this.mobile) {
        this.embeddedForwarder = new CallForwarder({
          roomTag: this.roomTag,
          sendDatagram: (dst, payload) => this.endpoint.sendDatagram({
            dst, srcPort: MEETING_PORT, dstPort: MEETING_PORT, payload,
          }),
          onUpstreamDemand: (senderTag, tracks) => {
            const sender = this.tagToPeer.get(senderTag >>> 0)
            if (sender && !this.stopped) {
              this.send(sender, { type: 'fwd_demand', senderTag: senderTag >>> 0, tracks: [...tracks] })
            }
          },
          onKeyframeNeeded: (senderTag, trackId) => {
            const sender = this.tagToPeer.get(senderTag >>> 0)
            if (sender && !this.stopped) {
              this.send(sender, { type: 'keyframe_v4', senderTag: senderTag >>> 0, trackId })
            }
          },
        })
      }

      if (options.dedicatedForwarder) {
        this.setDedicatedForwarder(options.dedicatedForwarder)
      }
      this.nackTimer = setInterval(() => this.pollNacks(), 50)
    }

    this.unregister = endpoint.registerService(MEETING_PORT, ({ peerId, src, payload }) => {
      this.receive(authenticatedMeetingPeer(src, peerId), payload)
    })
    this.timer = setInterval(() => this.tick(), 1000)
  }

  private localCapability(): PeerCapability {
    const directCount = this.getDirectPeers?.().size ?? this.peers.size
    return {
      peer: this.localPeer,
      direct: directCount > 0 || this.peers.size === 0,
      rttMs: 15,
      uplinkKbps: this.uplinkKbps,
      mobile: this.mobile,
      background: this.background,
      dedicated: false,
      maxFanout: this.background ? 0 : this.maxFanout,
    }
  }

  setDedicatedForwarder(address: string | null) {
    const peer = address ? canonicalPeer(address) : ''
    if (this.dedicatedForwarder && this.dedicatedForwarder !== peer) {
      this.topology?.removePeer(this.dedicatedForwarder)
      this.forwarderDemand.delete(this.dedicatedForwarder)
      this.lastForwarderSubSent.delete(this.dedicatedForwarder)
      this.lastForwarderEntries.delete(this.dedicatedForwarder)
    }
    this.dedicatedForwarder = peer || null
    this.dedicatedReady = false
    if (this.dedicatedForwarder && this.v4Enabled) {
      this.topology?.updateCapability({
        peer: this.dedicatedForwarder,
        direct: true,
        rttMs: 10,
        uplinkKbps: 500_000,
        mobile: false,
        background: false,
        dedicated: true,
        maxFanout: 100,
      })
      this.send(this.dedicatedForwarder, { type: 'fwd_hello' })
      this.syncSubscriptions()
      this.recomputeDemand()
    }
  }

  setBackground(background: boolean) {
    if (this.background === background) return
    this.background = background
    this.refreshTopology()
  }

  /** Re-evaluates helper eligibility immediately when direct WebRTC links open or close. */
  refreshTopology() {
    if (!this.v4Enabled || !this.topology) return
    const directSet = this.getDirectPeers?.()
    this.topology.updateCapability(this.localCapability())
    const now = performance.now()
    for (const [peer, state] of this.peers) {
      const isLocalDirect = directSet ? directSet.has(peer) : false
      if (isLocalDirect && !state.wasLocalDirect) {
        // A direct WebRTC path just replaced a seed-relayed path: reset any
        // relayed-path backoff so the direct link starts cleanly at target quality.
        state.tracks[2].adaptation = new CallAdaptation(LAYER_PROFILES.low.maxBitrate, now, LAYER_PROFILES.low.minBitrate)
        state.tracks[2].adaptation.target = LAYER_PROFILES.low.defaultBitrate
        state.tracks[3].adaptation = new CallAdaptation(LAYER_PROFILES.high.maxBitrate, now, LAYER_PROFILES.high.minBitrate)
        state.tracks[3].adaptation.target = LAYER_PROFILES.high.defaultBitrate
        state.tracks[4].adaptation = new CallAdaptation(LAYER_PROFILES.screen.maxBitrate, now, LAYER_PROFILES.screen.minBitrate)
        state.tracks[4].adaptation.target = LAYER_PROFILES.screen.defaultBitrate
        this.updateBitrate()
      }
      state.wasLocalDirect = isLocalDirect
      const direct = directSet ? (isLocalDirect || state.remoteCap.direct) : state.remoteCap.direct
      this.topology.updateCapability({
        peer,
        direct,
        rttMs: state.rttMs,
        uplinkKbps: state.remoteCap.uplinkKbps,
        mobile: state.remoteCap.mobile,
        background: state.remoteCap.background,
        dedicated: false,
        maxFanout: state.remoteCap.maxFanout,
      })
    }
    this.broadcastCapability()
    this.syncSubscriptions()
    this.recomputeDemand()
  }

  setViewport(focusedPeer: string | null, overrides?: ReadonlyMap<string, Partial<PeerSubscription>>) {
    this.focusedPeer = focusedPeer ? canonicalPeer(focusedPeer) || null : null
    if (overrides !== undefined) this.subscriptionOverrides = overrides
    if (this.v4Enabled) this.syncSubscriptions()
  }

  setSubscriptionOverrides(overrides?: ReadonlyMap<string, Partial<PeerSubscription>>) {
    this.subscriptionOverrides = overrides
    if (this.v4Enabled) this.syncSubscriptions()
  }

  addPeer(address: string, initiateDelayMs = 0) {
    const peer = canonicalPeer(address)
    if (!peer || this.stopped || this.peers.has(peer)) return
    const now = performance.now()
    const defaultSub: PeerSubscription = { audio: true, video: this.peers.size < 4 ? 'high' : 'low', screen: false }
    this.peers.set(peer, {
      receiver: new CallMediaReceiver(),
      heard: Date.now(),
      connected: false,
      failed: false,
      initiateAfter: now + Math.max(0, initiateDelayMs),
      v4: false,
      remoteAudio: false,
      remoteVideo: false,
      remoteScreen: false,
      seen: new Set(),
      adaptation: new CallAdaptation(callEncoding({}).maxBitrate, now),
      videoSending: false,
      feedbackAt: now,
      feedbackSequence: 0,
      receivedFrames: 0,
      receivedBytes: 0,
      tracks: {
        2: makeTrackFeedback(LAYER_PROFILES.low.maxBitrate, LAYER_PROFILES.low.defaultBitrate, now, LAYER_PROFILES.low.minBitrate),
        3: makeTrackFeedback(LAYER_PROFILES.high.maxBitrate, LAYER_PROFILES.high.defaultBitrate, now, LAYER_PROFILES.high.minBitrate),
        4: makeTrackFeedback(LAYER_PROFILES.screen.maxBitrate, LAYER_PROFILES.screen.defaultBitrate, now, LAYER_PROFILES.screen.minBitrate),
      },
      remoteSub: { ...defaultSub },
      localSub: { audio: true, video: 'none', screen: false },
      rttMs: 50,
      ackedKeyEpoch: 0,
      lastKeyReqAt: -Infinity,
      wasLocalDirect: this.getDirectPeers ? this.getDirectPeers().has(peer) : false,
      remoteCap: { direct: !this.getDirectPeers, uplinkKbps: 15_000, mobile: false, background: false, maxFanout: 4 },
    })
    if (this.v4Enabled) {
      const tag = senderTagFromPeer(peer)
      this.tagToPeer.set(tag, peer)
      this.originVerifier?.registerSender(tag, fromHex(peer.slice(2)))
      this.topology?.updateCapability(this.localCapability())
      this.topology?.updateCapability({
        peer,
        direct: this.getDirectPeers ? this.getDirectPeers().has(peer) : true,
        rttMs: 50,
        uplinkKbps: 15_000,
        mobile: false,
        background: false,
        dedicated: false,
        maxFanout: 4,
      })
    }
    if (initiateDelayMs <= 0) this.sendHello(peer)
    if (this.v4Enabled) {
      this.recomputeDemand()
    }
  }

  removePeer(address: string) {
    const peer = canonicalPeer(address)
    if (!this.peers.has(peer)) return
    this.peers.delete(peer)
    for (const item of this.pending.values()) item.waiting.delete(peer)
    this.layerGuard.removePeer(peer)
    this.forwarderDemand.delete(peer)
    this.lastForwarderSubSent.delete(peer)
    this.lastForwarderEntries.delete(peer)
    this.lastDirectSubSent.delete(peer)
    this.embeddedForwarder?.removeSubscriber(peer)
    this.topology?.removePeer(peer)
    if (this.v4Enabled) this.topology?.updateCapability(this.localCapability())

    if (this.v4Enabled) {
      const tag = senderTagFromPeer(peer)
      this.tagToPeer.delete(tag)
      this.v4Receiver?.removeSender(tag)
      this.keyRing?.removeSender(tag)
      this.originVerifier?.unregisterSender(tag)
      // Rotate fresh epoch key so removed participant cannot decrypt future frames.
      if (this.peers.size > 0 && this.keyRing) {
        this.keyRing.rotateLocalEpoch()
        for (const remaining of this.peers.keys()) this.sendSenderKeyTo(remaining)
        this.callbacks.keyframe?.(TRACK_VIDEO_LOW)
        this.callbacks.keyframe?.(TRACK_VIDEO_HIGH)
        this.callbacks.keyframe?.(TRACK_SCREEN)
      }
      this.syncSubscriptions()
      this.recomputeDemand()
    }
    this.updateBitrate()
  }

  peerIds() { return [...this.peers.keys()] }
  hasPeer(address: string) {
    const peer = canonicalPeer(address)
    return this.peers.has(peer) || (this.dedicatedForwarder !== null && peer === this.dedicatedForwarder)
  }

  setState(state: MediaState) {
    if ((state.videoEnabled || state.screenSharing) && !this.sendingVideo()) {
      for (const peer of this.peers.values()) {
        peer.adaptation.begin()
        peer.tracks[2].adaptation.begin()
        peer.tracks[3].adaptation.begin()
        peer.tracks[4].adaptation.begin()
      }
    }
    this.state = state
    const payload = this.packet({ type: 'state', state })
    for (const peer of this.peers.keys()) this.sendBytes(peer, payload)
    this.recomputeDemand()
  }

  chat(text: string): TransportChat {
    text = text.trim()
    if (!text || encoder.encode(text).length > 800) throw new Error('This message is too long. Try sending it in shorter parts.')
    if (this.pending.size >= 64) throw new Error('Messages are still sending. Try again shortly.')
    const message = { id: crypto.randomUUID(), text, timestamp: Date.now() }
    const payload = this.packet({ type: 'chat', ...message })
    const waiting = new Set(this.peers.keys())
    if (waiting.size) this.pending.set(message.id, { payload, waiting, expires: Date.now() + 15000 })
    for (const peer of waiting) this.sendBytes(peer, payload)
    return message
  }

  requestKeyframe(peer: string, trackId?: TrackId) {
    const canonical = canonicalPeer(peer)
    const state = this.peers.get(canonical)
    if (this.v4Enabled && state?.v4 && trackId) {
      const target = state.lastMediaVia && state.lastMediaVia !== canonical ? state.lastMediaVia : canonical
      this.send(target, { type: 'keyframe_v4', senderTag: senderTagFromPeer(canonical), trackId })
      return
    }
    this.send(canonical || peer, { type: 'keyframe', ...(trackId ? { trackId } : {}) })
  }

  sendLeave() {
    if (this.stopped) return []
    const payload = this.packet({ type: 'leave' })
    const targets = [...this.peers.keys()]
    if (this.dedicatedForwarder) targets.push(this.dedicatedForwarder)
    if (!targets.length) return []
    return targets.map(dst => this.endpoint.sendDatagram({ dst, srcPort: MEETING_PORT, dstPort: MEETING_PORT, payload }))
  }

  private directSubTracksFor(peer: string, state: Peer): TrackId[] {
    const route = this.topology?.routeForSender(peer, senderTagFromPeer(peer))
    if (route?.mode === 'assisted' && route.primary && route.primary !== this.localPeer && route.primary !== peer) {
      return []
    }
    return subscriptionToTracks(state.localSub)
  }

  private sendHello(peer: string) {
    const state = this.peers.get(peer)
    if (this.v4Enabled) {
      this.send(peer, {
        type: 'hello',
        state: this.state,
        v4: true,
        cap: this.localCapability(),
        sub: state ? this.directSubTracksFor(peer, state) : undefined,
      })
    } else {
      this.send(peer, { type: 'hello', state: this.state })
    }
  }

  private broadcastCapability() {
    if (!this.v4Enabled) return
    const payload = this.packet({ type: 'cap', cap: this.localCapability() })
    for (const [peer, state] of this.peers) {
      if (state.connected) this.sendBytes(peer, payload)
    }
  }

  private sendSenderKeyTo(peer: string) {
    if (!this.identity || !this.keyRing) return
    const current = this.keyRing.localSenderSecret()
    if (!current) return
    const wrapped = wrapSenderKey(this.identity.secretKey, peer, this.roomTag, current.epoch, current.secret)
    this.send(peer, { type: 'sender_key', epoch: current.epoch, wrapped })
  }

  private syncSubscriptions() {
    if (!this.v4Enabled) return
    const viewportPeers = [...this.peers.entries()].map(([peer, p]) => ({
      peer,
      videoEnabled: p.remoteVideo,
      screenSharing: p.remoteScreen,
    }))
    const desired = computeViewportSubscriptions({
      peers: viewportPeers,
      focusedPeer: this.focusedPeer,
      maxVideoDecoders: this.maxVideoDecoders,
      degradedPeers: this.layerGuard.degradedSet(),
      overrides: this.subscriptionOverrides,
    })

    // Group forwarder subscriptions by chosen helper/forwarder peer.
    const byForwarder = new Map<string, ForwarderSubscriptionEntry[]>()
    for (const [peer, state] of this.peers) {
      const nextSub = desired.get(peer) ?? { audio: true, video: 'none', screen: false }
      const changed = !subscriptionsEqual(state.localSub, nextSub)
      const prevVideo = state.localSub.video
      state.localSub = nextSub
      if (!state.connected) continue
      const tracks = subscriptionToTracks(nextSub)
      const tag = senderTagFromPeer(peer)
      if (prevVideo !== nextSub.video) {
        const nextTrack = nextSub.video === 'high' ? TRACK_VIDEO_HIGH : nextSub.video === 'low' ? TRACK_VIDEO_LOW : undefined
        if (nextTrack) {
          this.v4Receiver?.resetTrack(tag, nextTrack)
          const tState = state.tracks[nextTrack]
          tState.lastHighest = undefined
          tState.receivedFrames = 0
          tState.receivedBytes = 0
          const now = performance.now()
          tState.feedbackAt = now
          tState.subscribedAt = now
        }
      }
      const route = this.topology?.routeForSender(peer, tag)

      if (route?.mode === 'assisted' && route.primary && route.primary !== this.localPeer && route.primary !== peer) {
        let list = byForwarder.get(route.primary)
        if (!list) {
          list = []
          byForwarder.set(route.primary, list)
        }
        list.push({ senderTag: tag, senderPeer: peer, tracks })
        // Tell the direct sender we're pulling via forwarder so it stops direct duplicate uploads.
        const directKey = `via:${route.primary}`
        if (changed || this.lastDirectSubSent.get(peer) !== directKey) {
          this.lastDirectSubSent.set(peer, directKey)
          this.send(peer, { type: 'sub', tracks: [], via: route.primary })
        }
      } else {
        const directKey = `direct:${tracks.join(',')}`
        if (changed || this.lastDirectSubSent.get(peer) !== directKey) {
          this.lastDirectSubSent.set(peer, directKey)
          this.send(peer, { type: 'sub', tracks })
        }
      }
    }

    // Flush forwarder subscriptions (including clearing obsolete ones).
    const allForwarders = new Set<string>([...this.lastForwarderSubSent.keys(), ...byForwarder.keys()])
    for (const fwd of allForwarders) {
      const fwdState = this.peers.get(fwd)
      if (fwd !== this.dedicatedForwarder && !fwdState?.connected) continue
      const entries = byForwarder.get(fwd) ?? []
      const encoded = JSON.stringify(entries)
      if (this.lastForwarderSubSent.get(fwd) === encoded) continue
      if (entries.length) {
        this.lastForwarderSubSent.set(fwd, encoded)
        this.lastForwarderEntries.set(fwd, entries)
      } else {
        this.lastForwarderSubSent.delete(fwd)
        this.lastForwarderEntries.delete(fwd)
      }
      this.send(fwd, { type: 'fwd_sub', entries })
    }
  }

  private recomputeDemand() {
    if (!this.v4Enabled) {
      const hasConnected = [...this.peers.values()].some(p => p.connected)
      const next: MediaDemand = {
        audio: hasConnected && this.state.audioEnabled,
        videoLow: false,
        videoHigh: hasConnected && (this.state.videoEnabled || this.state.screenSharing),
        screen: false,
      }
      this.applyDemand(next)
      return
    }

    const directSubs = new Map<string, PeerSubscription>()
    for (const [peer, state] of this.peers) {
      if (!state.connected) continue
      if (state.v4) directSubs.set(peer, state.remoteSub)
      else directSubs.set(peer, { audio: true, video: 'high', screen: false })
    }
    const agg = aggregatePublisherDemand(directSubs)

    let fwdAudio = false, fwdLow = false, fwdHigh = false, fwdScreen = false
    for (const tracks of this.forwarderDemand.values()) {
      if (tracks.has(TRACK_AUDIO)) fwdAudio = true
      if (tracks.has(TRACK_VIDEO_LOW)) fwdLow = true
      if (tracks.has(TRACK_VIDEO_HIGH)) fwdHigh = true
      if (tracks.has(TRACK_SCREEN)) fwdScreen = true
    }

    const next: MediaDemand = {
      audio: (agg.wantAudio || fwdAudio),
      videoLow: (agg.wantLow || fwdLow),
      videoHigh: (agg.wantHigh || fwdHigh),
      screen: (agg.wantScreen || fwdScreen),
    }
    this.applyDemand(next)
  }

  private applyDemand(next: MediaDemand) {
    const prev = this.currentDemand
    if (
      prev.audio === next.audio
      && prev.videoLow === next.videoLow
      && prev.videoHigh === next.videoHigh
      && prev.screen === next.screen
    ) return
    this.currentDemand = next
    this.callbacks.demand?.({ ...next })
  }

  private targetsForV4Track(trackId: TrackId): Set<string> {
    const targets = new Set<string>()
    for (const [fwdPeer, tracks] of this.forwarderDemand) {
      if (tracks.has(trackId)) targets.add(fwdPeer)
    }
    for (const [peer, state] of this.peers) {
      if (!state.connected || !state.v4) continue
      if (trackId === TRACK_AUDIO && state.remoteSub.audio) targets.add(peer)
      else if (trackId === TRACK_VIDEO_LOW && state.remoteSub.video === 'low') targets.add(peer)
      else if (trackId === TRACK_VIDEO_HIGH && state.remoteSub.video === 'high') targets.add(peer)
      else if (trackId === TRACK_SCREEN && state.remoteSub.screen) targets.add(peer)
    }
    return targets
  }

  private cacheForRetransmit(trackId: TrackId, seq: number, packets: Uint8Array[], now: number) {
    if (trackId === TRACK_AUDIO) return
    for (const [k, v] of this.retransmitCache) {
      if (now - v.at > 300) {
        this.retransmitCache.delete(k)
        this.retransmitBytes -= v.bytes
      } else break
    }
    const bytes = packets.reduce((n, p) => n + p.byteLength, 0)
    const key = `${trackId}:${seq >>> 0}`
    this.retransmitCache.set(key, { at: now, packets, bytes })
    this.retransmitBytes += bytes
    while (this.retransmitCache.size > 16 || this.retransmitBytes > 1_048_576) {
      const oldest = this.retransmitCache.entries().next().value
      if (!oldest) break
      this.retransmitCache.delete(oldest[0])
      this.retransmitBytes -= oldest[1].bytes
    }
  }

  async sendMedia(frame: TransportMediaFrame, allowed: () => boolean = () => true) {
    if (this.stopped || !allowed()) return
    const trackId: TrackId = frame.trackId ?? (frame.kind === 1 ? TRACK_AUDIO : TRACK_VIDEO_HIGH)

    // Send IC04 SFrame-encrypted frames to v4 subscribers & active blind forwarders.
    if (this.v4Enabled && this.keyRing) {
      const targets = this.targetsForV4Track(trackId)
      if (targets.size > 0) {
        const mediaKey = this.keyRing.localMediaKey()
        if (mediaKey) {
          const flags = (frame.key ? FLAG_KEYFRAME : 0) | (frame.discardable ? FLAG_DISCARDABLE : 0) | FLAG_ENCRYPTED
          const header = {
            roomTag: this.roomTag,
            senderTag: this.localTag,
            trackId,
            flags,
            keyEpoch: this.keyRing.currentEpoch,
            seq: frame.seq >>> 0,
            timestampUs: frame.timestamp,
          }
          const sealed = sealCallV4Frame(mediaKey, header, frame.bytes)
          this.originSigner?.record(header, sealed)
          const packets = encodeCallV4({ ...header, payload: sealed })
          if (packets.length) {
            const now = performance.now()
            this.cacheForRetransmit(trackId, frame.seq, packets, now)
            this.uploadedFrames[trackId]++
            await Promise.allSettled([...targets].map(dst => this.sendV4ToPeer(dst, trackId, frame.key, frame.seq, packets, allowed)))
            // Periodically flush signed origin commitments (~300ms or keyframes).
            if (this.originSigner && (frame.key || now - this.lastOriginFlushAt >= 300 || this.originSigner.pendingCount >= 16)) {
              this.flushOriginCommits(now)
            }
          }
        }
      }
    }

    // Legacy IC03 fallback for non-v4 peers (only audio + primary high/screen video).
    const legacyPeers = [...this.peers.entries()].filter(([, s]) => s.connected && (!this.v4Enabled || !s.v4))
    if (!legacyPeers.length) return
    if (this.v4Enabled && trackId === TRACK_VIDEO_LOW) return
    const packets = encodeCallMedia(this.room, frame)
    if (!packets.length) return
    await Promise.allSettled(legacyPeers.map(async ([peer, state]) => {
      if (frame.kind === 2) {
        if (!state.videoSending) { state.videoSending = true; state.adaptation.begin() }
        state.adaptation.sentFrame(frame.seq)
      }
      const key = `${peer}:${frame.kind}`
      if (this.mediaBusy.has(key)) {
        if (frame.kind === 2 && frame.key) state.pendingKey = { packets, allowed }
        return
      }
      this.mediaBusy.add(key)
      try {
        let batch: { packets: Uint8Array[]; allowed: () => boolean } | undefined = { packets, allowed }
        while (batch) {
          for (const payload of batch.packets) {
            if (this.stopped || !this.peers.has(peer) || !batch.allowed()) return
            await this.endpoint.sendDatagram({ dst: peer, srcPort: MEETING_PORT, dstPort: MEETING_PORT, payload })
          }
          batch = frame.kind === 2 ? state.pendingKey : undefined
          if (batch) state.pendingKey = undefined
        }
      } finally { this.mediaBusy.delete(key) }
    }))
  }

  private async sendV4ToPeer(
    dst: string,
    trackId: TrackId,
    isKey: boolean,
    seq: number,
    packets: Uint8Array[],
    allowed: () => boolean,
  ) {
    const peerState = this.peers.get(dst)
    if (peerState && trackId !== TRACK_AUDIO) {
      const tState = peerState.tracks[trackId]
      if (!tState.sending) { tState.sending = true; tState.adaptation.begin() }
      tState.adaptation.sentFrame(seq)
    }

    const busyKey = `v4:${dst}:${trackId === TRACK_AUDIO ? 'a' : trackId}`
    if (this.mediaBusy.has(busyKey)) {
      if (trackId !== TRACK_AUDIO && isKey) {
        this.pendingV4Keys.set(busyKey, { packets, allowed })
      }
      return
    }
    this.mediaBusy.add(busyKey)
    try {
      let batch: { packets: Uint8Array[]; allowed: () => boolean } | undefined = { packets, allowed }
      while (batch) {
        for (const payload of batch.packets) {
          if (this.stopped || !batch.allowed()) return
          if (!this.peers.has(dst) && dst !== this.dedicatedForwarder) return
          this.uploadedPackets[trackId]++
          this.uploadedBytes[trackId] += payload.byteLength
          await this.endpoint.sendDatagram({ dst, srcPort: MEETING_PORT, dstPort: MEETING_PORT, payload })
        }
        batch = trackId !== TRACK_AUDIO ? this.pendingV4Keys.get(busyKey) : undefined
        if (batch) this.pendingV4Keys.delete(busyKey)
      }
    } finally {
      this.mediaBusy.delete(busyKey)
    }
  }

  private flushOriginCommits(now: number) {
    if (!this.originSigner) return
    const commit = this.originSigner.flush()
    if (!commit) return
    this.lastOriginFlushAt = now
    const payload = this.packet({ type: 'origin_commit', commit })
    for (const [peer, state] of this.peers) {
      if (state.connected && state.v4) this.sendBytes(peer, payload)
    }
  }

  private pollNacks() {
    if (this.stopped || !this.v4Receiver) return
    const nacks = this.v4Receiver.missingNacks()
    for (const nack of nacks) {
      const senderPeer = this.tagToPeer.get(nack.senderTag >>> 0)
      if (!senderPeer) continue
      const state = this.peers.get(senderPeer)
      if (!state) continue
      const hop = state.lastMediaVia || senderPeer
      this.nacksSent++
      this.send(hop, { type: 'nack_v4', ...nack })
    }
  }

  private packet(data: object) { return encoder.encode(JSON.stringify({ v: 1, room: this.room, ...data })) }
  private send(peer: string, data: object) { this.sendBytes(peer, this.packet(data)) }
  private sendBytes(peer: string, payload: Uint8Array) {
    if (!this.stopped) void this.endpoint.sendDatagram({ dst: peer, srcPort: MEETING_PORT, dstPort: MEETING_PORT, payload }).catch(() => {})
  }

  private receive(peer: string, payload: Uint8Array) {
    if (this.stopped || !peer) return
    const isDedicated = this.dedicatedForwarder !== null && peer === this.dedicatedForwarder
    const state = this.peers.get(peer)
    if (!state && !isDedicated) return

    // IC04 binary media datagram
    if (this.v4Enabled && isCallV4Packet(payload)) {
      this.receiveV4Datagram(peer, payload)
      return
    }

    // Legacy IC03 binary media datagram
    if (state && payload[0] === 73) {
      const frame = state.receiver.receive(this.room, payload)
      if (frame) {
        this.heard(peer, state)
        if (frame.kind === 2) { state.receivedFrames++; state.receivedBytes += frame.bytes.length }
        this.callbacks.media?.(peer, frame)
      }
      return
    }

    if (payload.length > 4096) return
    try {
      const p = JSON.parse(decoder.decode(payload))
      if (p.v !== 1 || p.room !== this.room) return

      // Dedicated blind forwarder control messages
      if (isDedicated) {
        if (p.type === 'fwd_welcome') {
          this.dedicatedReady = true
          this.topology?.updateCapability({
            peer,
            direct: true,
            rttMs: 10,
            uplinkKbps: typeof p.uplinkKbps === 'number' ? p.uplinkKbps : 500_000,
            mobile: false,
            background: false,
            dedicated: true,
            maxFanout: typeof p.maxFanout === 'number' ? p.maxFanout : 100,
          })
          this.syncSubscriptions()
          this.recomputeDemand()
        } else if (p.type === 'fwd_demand' && Array.isArray(p.tracks)) {
          this.handleForwarderDemand(peer, p.tracks)
        } else if (p.type === 'keyframe_v4' && isValidTrackId(p.trackId)) {
          this.callbacks.keyframe?.(p.trackId)
        }
        return
      }

      if (!state) return
      switch (p.type) {
        case 'hello':
        case 'state':
          if (!p.state || ['audioEnabled', 'videoEnabled', 'screenSharing'].some(k => typeof p.state[k] !== 'boolean')) return
          state.remoteAudio = p.state.audioEnabled
          state.remoteVideo = p.state.videoEnabled
          state.remoteScreen = p.state.screenSharing
          if (p.v4 === true && this.v4Enabled) state.v4 = true
          if (p.cap && this.v4Enabled) this.applyRemoteCap(peer, state, p.cap)
          if (Array.isArray(p.sub) && this.v4Enabled) this.applyRemoteSub(state, p.sub)
          this.heard(peer, state)
          this.callbacks.state?.(peer, p.state)
          if (this.v4Enabled) {
            this.syncSubscriptions()
            this.recomputeDemand()
          }
          if (p.type === 'hello') {
            this.send(peer, {
              type: 'state',
              state: this.state,
              ...(this.v4Enabled ? { v4: true, cap: this.localCapability(), sub: this.directSubTracksFor(peer, state) } : {}),
            })
            if (this.v4Enabled && state.ackedKeyEpoch !== (this.keyRing?.currentEpoch ?? 0)) {
              this.sendSenderKeyTo(peer)
            }
            this.callbacks.heartbeat?.(peer)
          } else if (this.v4Enabled && state.ackedKeyEpoch !== (this.keyRing?.currentEpoch ?? 0)) {
            this.sendSenderKeyTo(peer)
          }
          break
        case 'cap':
          if (p.cap && this.v4Enabled) {
            this.heard(peer, state)
            this.applyRemoteCap(peer, state, p.cap)
            this.syncSubscriptions()
          }
          break
        case 'sender_key':
          if (this.identity && this.keyRing && typeof p.epoch === 'number' && typeof p.wrapped === 'string') {
            this.heard(peer, state)
            state.v4 = true
            const secret = unwrapSenderKey(this.identity.secretKey, peer, this.roomTag, p.epoch, p.wrapped)
            if (secret) {
              this.keyRing.installRemoteKey(senderTagFromPeer(peer), p.epoch, secret)
              this.send(peer, { type: 'key_ack', epoch: p.epoch })
            }
          }
          break
        case 'key_ack':
          if (this.v4Enabled && typeof p.epoch === 'number' && p.epoch === (this.keyRing?.currentEpoch ?? 0)) {
            this.heard(peer, state)
            state.ackedKeyEpoch = p.epoch
          }
          break
        case 'key_req':
          if (this.v4Enabled) {
            this.heard(peer, state)
            this.sendSenderKeyTo(peer)
          }
          break
        case 'origin_commit':
          if (this.originVerifier && p.commit) {
            this.heard(peer, state)
            const commit = p.commit as OriginCommitMessage
            if ((commit.senderTag >>> 0) !== senderTagFromPeer(peer)) return
            const verdict = this.originVerifier.verifyCommit(commit)
            this.originVerified += verdict.verified
            if (verdict.forged > 0) {
              this.originForged += verdict.forged
              const via = state.lastMediaVia || peer
              if (via !== peer) {
                this.topology?.markHelperUnhealthy(via)
                this.syncSubscriptions()
              }
              this.callbacks.originForgery?.(peer, via)
            }
          }
          break
        case 'sub':
          if (Array.isArray(p.tracks) && this.v4Enabled) {
            this.heard(peer, state)
            state.v4 = true
            this.applyRemoteSub(state, p.tracks)
            this.recomputeDemand()
          }
          break
        case 'fwd_sub':
          if (this.embeddedForwarder && Array.isArray(p.entries)) {
            this.heard(peer, state)
            const entries: ForwarderSubscriptionEntry[] = []
            for (const item of p.entries) {
              if (typeof item?.senderTag !== 'number' || !Array.isArray(item.tracks)) continue
              const tracks = item.tracks.filter((t: unknown): t is TrackId => typeof t === 'number' && isValidTrackId(t))
              entries.push({ senderTag: item.senderTag >>> 0, tracks })
            }
            this.embeddedForwarder.setSubscriptions(peer, entries)
          }
          break
        case 'fwd_demand':
          if (Array.isArray(p.tracks) && this.v4Enabled) {
            this.heard(peer, state)
            this.handleForwarderDemand(peer, p.tracks)
          }
          break
        case 'nack_v4':
          if (this.v4Enabled && typeof p.senderTag === 'number' && isValidTrackId(p.trackId) && typeof p.seq === 'number' && Array.isArray(p.missing)) {
            const nack: CallV4Nack = {
              senderTag: p.senderTag >>> 0,
              trackId: p.trackId,
              seq: p.seq >>> 0,
              missing: p.missing.filter((i: unknown): i is number => typeof i === 'number' && Number.isInteger(i) && i >= 0).slice(0, 64),
            }
            if (nack.senderTag === this.localTag) {
              void this.serveLocalNack(peer, nack)
            } else if (this.embeddedForwarder) {
              void this.embeddedForwarder.handleNack(peer, nack)
            }
          }
          break
        case 'keyframe_v4':
          if (this.v4Enabled && typeof p.senderTag === 'number' && isValidTrackId(p.trackId)) {
            if ((p.senderTag >>> 0) === this.localTag) {
              this.callbacks.keyframe?.(p.trackId)
            } else if (this.embeddedForwarder) {
              this.embeddedForwarder.handleKeyframeRequest(p.senderTag >>> 0, p.trackId)
            }
          }
          break
        case 'feedback_v4':
          if (this.v4Enabled && (p.trackId === 2 || p.trackId === 3 || p.trackId === 4)) {
            const tState = state.tracks[p.trackId as 2 | 3 | 4]
            if (tState.sending) {
              tState.adaptation.feedback(p)
              this.updateBitrate()
            }
          }
          break
        case 'ping_v4':
          if (typeof p.t === 'number') this.send(peer, { type: 'pong_v4', t: p.t })
          break
        case 'pong_v4':
          if (typeof p.t === 'number') {
            this.heard(peer, state)
            const rtt = Math.max(1, Math.min(2000, Math.round(performance.now() - p.t)))
            state.rttMs = Math.round(state.rttMs * 0.6 + rtt * 0.4)
          }
          break
        case 'chat':
          if (typeof p.id !== 'string' || p.id.length > 64 || typeof p.text !== 'string' || !p.text.trim() || encoder.encode(p.text).length > 800 || !Number.isSafeInteger(p.timestamp)) return
          this.heard(peer, state)
          this.send(peer, { type: 'ack', id: p.id })
          if (state.seen.has(p.id)) return
          state.seen.add(p.id)
          while (state.seen.size > 256) state.seen.delete(state.seen.values().next().value!)
          this.callbacks.message?.(peer, { id: p.id, text: p.text, timestamp: p.timestamp })
          break
        case 'ack': {
          const pending = this.pending.get(p.id)
          pending?.waiting.delete(peer)
          if (!pending?.waiting.size) this.pending.delete(p.id)
          break
        }
        case 'keyframe':
          this.callbacks.keyframe?.(isValidTrackId(p.trackId) ? p.trackId : undefined)
          break
        case 'feedback':
          if (this.sendingVideo() && state.videoSending) {
            state.adaptation.feedback(p)
            this.updateBitrate()
          }
          break
        case 'leave':
          this.removePeer(peer)
          this.callbacks.leave?.(peer)
          break
      }
    } catch { /* Malformed datagrams are not meeting messages. */ }
  }

  private receiveV4Datagram(fromPeer: string, payload: Uint8Array) {
    const header = peekCallV4Header(payload)
    if (!header || !roomTagsEqual(header.roomTag, this.roomTag)) return

    // 1. Blind forwarding to downstream subscribers (zero decryption, zero reassembly).
    if (this.embeddedForwarder) {
      void this.embeddedForwarder.ingestDatagram(fromPeer, payload)
    }

    // 2. Local consumption if the sender is an admitted participant.
    const senderPeer = this.tagToPeer.get(header.senderTag >>> 0)
    if (!senderPeer) return
    const state = this.peers.get(senderPeer)
    if (!state || !this.v4Receiver || !this.keyRing) return

    state.v4 = true
    state.lastMediaVia = fromPeer
    const assembled = this.v4Receiver.receive(payload)
    if (!assembled) return

    const mediaKey = this.keyRing.remoteMediaKey(assembled.senderTag, assembled.keyEpoch)
    if (!mediaKey) {
      const now = performance.now()
      if (now - state.lastKeyReqAt >= 500) {
        state.lastKeyReqAt = now
        this.send(senderPeer, { type: 'key_req', epoch: assembled.keyEpoch })
      }
      return
    }
    const plaintext = openCallV4Frame(mediaKey, assembled, assembled.payload)
    if (!plaintext) return

    this.originVerifier?.observeFrame(assembled, assembled.payload)
    this.heard(senderPeer, state)
    this.receivedFrames[assembled.trackId]++

    if (assembled.trackId !== TRACK_AUDIO) {
      const tState = state.tracks[assembled.trackId]
      tState.receivedFrames++
      tState.receivedBytes += plaintext.byteLength
    }
    this.callbacks.media?.(senderPeer, {
      kind: assembled.trackId === TRACK_AUDIO ? 1 : 2,
      trackId: assembled.trackId,
      seq: assembled.seq,
      timestamp: assembled.timestampUs,
      key: (assembled.flags & FLAG_KEYFRAME) !== 0,
      discardable: (assembled.flags & FLAG_DISCARDABLE) !== 0,
      bytes: plaintext,
    })
  }

  private async serveLocalNack(dst: string, nack: CallV4Nack) {
    const cached = this.retransmitCache.get(`${nack.trackId}:${nack.seq >>> 0}`)
    if (!cached || performance.now() - cached.at > 300) return
    for (const index of new Set(nack.missing)) {
      const pkt = cached.packets[index]
      if (!pkt || this.stopped) continue
      this.nacksServed++
      this.uploadedPackets[nack.trackId]++
      this.uploadedBytes[nack.trackId] += pkt.byteLength
      try {
        await this.endpoint.sendDatagram({ dst, srcPort: MEETING_PORT, dstPort: MEETING_PORT, payload: pkt })
      } catch {
        return
      }
    }
  }

  private handleForwarderDemand(fwdPeer: string, rawTracks: unknown[]) {
    const set = new Set<TrackId>()
    for (const t of rawTracks) if (typeof t === 'number' && isValidTrackId(t)) set.add(t)
    const prev = this.forwarderDemand.get(fwdPeer)
    if (set.size) this.forwarderDemand.set(fwdPeer, set)
    else this.forwarderDemand.delete(fwdPeer)
    // Emit immediate keyframe if a video track was newly demanded.
    for (const t of set) {
      if (t !== TRACK_AUDIO && !prev?.has(t)) this.callbacks.keyframe?.(t)
    }
    this.recomputeDemand()
  }

  private applyRemoteSub(state: Peer, rawTracks: unknown[]) {
    const tracks = rawTracks.filter((t): t is TrackId => typeof t === 'number' && isValidTrackId(t))
    const prev = state.remoteSub
    const next = tracksToSubscription(tracks)
    state.remoteSub = next
    const now = performance.now()
    // Reset per-track adaptation cleanly when a peer unsubscribes and later re-subscribes
    // so stale sequence/frameDebt from before the pause cannot drag down the resumed layer.
    if (next.video !== 'low') {
      state.tracks[2].sending = false
    } else if (prev.video !== 'low') {
      state.tracks[2].adaptation = new CallAdaptation(LAYER_PROFILES.low.maxBitrate, now, LAYER_PROFILES.low.minBitrate)
      state.tracks[2].adaptation.target = LAYER_PROFILES.low.defaultBitrate
    }
    if (next.video !== 'high') {
      state.tracks[3].sending = false
    } else if (prev.video !== 'high') {
      state.tracks[3].adaptation = new CallAdaptation(LAYER_PROFILES.high.maxBitrate, now, LAYER_PROFILES.high.minBitrate)
      state.tracks[3].adaptation.target = LAYER_PROFILES.high.defaultBitrate
    }
    if (!next.screen) {
      state.tracks[4].sending = false
    } else if (!prev.screen) {
      state.tracks[4].adaptation = new CallAdaptation(LAYER_PROFILES.screen.maxBitrate, now, LAYER_PROFILES.screen.minBitrate)
      state.tracks[4].adaptation.target = LAYER_PROFILES.screen.defaultBitrate
    }

    if (next.video !== 'none' && next.video !== prev.video) {
      this.callbacks.keyframe?.(next.video === 'high' ? TRACK_VIDEO_HIGH : TRACK_VIDEO_LOW)
    }
    if (next.screen && !prev.screen) {
      this.callbacks.keyframe?.(TRACK_SCREEN)
    }
    this.updateBitrate()
  }

  private applyRemoteCap(peer: string, state: Peer, raw: any) {
    if (!this.topology) return
    state.remoteCap = {
      direct: typeof raw.direct === 'boolean' ? raw.direct : state.remoteCap.direct,
      uplinkKbps: typeof raw.uplinkKbps === 'number' ? raw.uplinkKbps : state.remoteCap.uplinkKbps,
      mobile: typeof raw.mobile === 'boolean' ? raw.mobile : state.remoteCap.mobile,
      background: typeof raw.background === 'boolean' ? raw.background : state.remoteCap.background,
      maxFanout: typeof raw.maxFanout === 'number' ? raw.maxFanout : state.remoteCap.maxFanout,
    }
    const localDirect = this.getDirectPeers ? this.getDirectPeers().has(peer) : false
    const direct = localDirect || state.remoteCap.direct
    this.topology.updateCapability({
      peer,
      direct,
      rttMs: state.rttMs,
      uplinkKbps: state.remoteCap.uplinkKbps,
      mobile: state.remoteCap.mobile,
      background: state.remoteCap.background,
      dedicated: false,
      maxFanout: state.remoteCap.maxFanout,
    })
  }

  private heard(peer: string, state: Peer) {
    state.heard = Date.now()
    state.failed = false
    if (!state.connected) {
      state.connected = true
      state.adaptation.begin()
      state.tracks[2].adaptation.begin()
      state.tracks[3].adaptation.begin()
      state.tracks[4].adaptation.begin()
      if (this.v4Enabled) {
        if (state.ackedKeyEpoch !== (this.keyRing?.currentEpoch ?? 0)) this.sendSenderKeyTo(peer)
        this.syncSubscriptions()
        this.recomputeDemand()
      }
      this.updateBitrate()
      this.callbacks.connected?.(peer)
    }
  }

  private sendingVideo() { return this.state.videoEnabled || this.state.screenSharing }

  private updateBitrate() {
    if (this.v4Enabled) {
      const computeLayer = (trackId: 2 | 3 | 4, defaultBps: number): number => {
        let min = Infinity
        for (const peer of this.peers.values()) {
          if (!peer.connected || !peer.v4) continue
          const subscribed = (trackId === 2 && peer.remoteSub.video === 'low')
            || (trackId === 3 && peer.remoteSub.video === 'high')
            || (trackId === 4 && peer.remoteSub.screen)
          if (!subscribed) continue
          const target = peer.tracks[trackId].adaptation.target
          if (target < min) min = target
        }
        return min === Infinity ? defaultBps : min
      }

      const nextLayers: LayerBitrates = {
        low: computeLayer(2, LAYER_PROFILES.low.defaultBitrate),
        high: computeLayer(3, LAYER_PROFILES.high.defaultBitrate),
        screen: computeLayer(4, LAYER_PROFILES.screen.defaultBitrate),
      }
      const changed = nextLayers.low !== this.bitrates.low
        || nextLayers.high !== this.bitrates.high
        || nextLayers.screen !== this.bitrates.screen
      if (changed) {
        this.bitrates = nextLayers
        this.callbacks.layerBitrates?.({ ...nextLayers })
      }
      const primary = this.currentDemand.videoHigh ? nextLayers.high : this.currentDemand.videoLow ? nextLayers.low : nextLayers.high
      if (primary !== this.targetBitrate) {
        this.targetBitrate = primary
        this.callbacks.bitrate?.(primary)
      }
      return
    }

    // Legacy IC03 single-bitrate path
    let next = Infinity
    for (const peer of this.peers.values()) {
      if (peer.connected && peer.adaptation.target < next) next = peer.adaptation.target
    }
    if (next === Infinity) next = 1_200_000
    if (next !== this.targetBitrate) { this.targetBitrate = next; this.callbacks.bitrate?.(next) }
  }

  private tick() {
    this.tickCount++
    const wallNow = Date.now()
    for (const [id, item] of this.pending) {
      if (!item.waiting.size) { this.pending.delete(id); continue }
      if (wallNow >= item.expires) {
        this.pending.delete(id); this.callbacks.error?.('A message could not reach everyone. Try sending it again.')
      } else for (const peer of item.waiting) this.sendBytes(peer, item.payload)
    }

    const perfNow = performance.now()
    if (this.v4Enabled && this.dedicatedForwarder && (!this.dedicatedReady || this.tickCount % 5 === 0)) {
      this.send(this.dedicatedForwarder, { type: 'fwd_hello' })
      // Re-push forwarder subscriptions if the dedicated forwarder just came online.
      if (!this.dedicatedReady) {
        this.lastForwarderSubSent.delete(this.dedicatedForwarder)
        this.syncSubscriptions()
      }
    }
    if (this.v4Enabled && this.topology && this.tickCount % 3 === 0) {
      const prevMode = this.topology.mode(perfNow)
      this.topology.updateCapability(this.localCapability())
      this.broadcastCapability()
      if (this.topology.mode(perfNow) !== prevMode) {
        this.syncSubscriptions()
        this.recomputeDemand()
      }
      // Refresh forwarder subscriptions and upstream demand over unreliable FIPS datagrams
      // so a single dropped control packet during WebRTC upgrade self-heals within <=3s.
      for (const [fwd, entries] of this.lastForwarderEntries) {
        if (!entries.length) continue
        if (fwd !== this.dedicatedForwarder && !this.peers.get(fwd)?.connected) continue
        this.send(fwd, { type: 'fwd_sub', entries })
      }
      if (this.embeddedForwarder) {
        for (const [tag, senderPeer] of this.tagToPeer) {
          if (!this.peers.get(senderPeer)?.connected) continue
          const tracks = this.embeddedForwarder.upstreamTracks(tag)
          if (tracks.length) this.send(senderPeer, { type: 'fwd_demand', senderTag: tag, tracks })
        }
      }
      for (const [peer, state] of this.peers) {
        if (state.connected && state.v4) {
          this.send(peer, { type: 'ping_v4', t: perfNow })
        }
      }
    }

    let helloPayload: Uint8Array | undefined
    let guardChanged = false

    for (const [peer, state] of this.peers) {
      if (this.v4Enabled && state.v4 && state.connected && this.v4Receiver) {
        const tag = senderTagFromPeer(peer)
        // Per-track feedback and receiver-side layer guard (high -> low on local congestion).
        for (const trackId of [2, 3, 4] as const) {
          const tState = state.tracks[trackId]
          const interval = Math.round(perfNow - tState.feedbackAt)
          if (interval < 200) continue
          const subscribed = (trackId === 2 && state.localSub.video === 'low')
            || (trackId === 3 && state.localSub.video === 'high')
            || (trackId === 4 && state.localSub.screen)
          const remoteActive = trackId === 4 ? state.remoteScreen : state.remoteVideo
          if (subscribed && (remoteActive || tState.receivedFrames > 0) && interval <= 5000) {
            const highest = this.v4Receiver.highestSeq(tag, trackId)
            this.send(peer, {
              type: 'feedback_v4',
              trackId,
              feedback_seq: tState.feedbackSequence++ >>> 0,
              video_seq: highest,
              received_frames: tState.receivedFrames,
              received_bytes: tState.receivedBytes,
              interval_ms: interval,
            })
            if ((trackId === 2 || trackId === 3) && state.remoteVideo) {
              const first = this.v4Receiver.firstSeq(tag, trackId)
              const baseline = tState.lastHighest !== undefined
                ? tState.lastHighest
                : first !== undefined
                  ? (first - 1) >>> 0
                  : undefined
              // Give newly subscribed tracks a 2.5s startup grace window before treating 0 frames as a stall.
              const inStartupGrace = highest === undefined && tState.receivedFrames === 0 && (perfNow - tState.subscribedAt < 2500)
              const expected = highest === undefined
                ? (inStartupGrace ? 0 : (tState.receivedFrames === 0 ? 15 : 0))
                : baseline === undefined
                  ? tState.receivedFrames
                  : Math.min(300, (highest - baseline) >>> 0)
              tState.lastHighest = highest
              if (!inStartupGrace) {
                const currentLayer: VideoLayer = trackId === 3 ? 'high' : 'low'
                const prevDegraded = this.layerGuard.isDegraded(peer)
                this.layerGuard.report(peer, currentLayer, {
                  expected,
                  received: tState.receivedFrames,
                  intervalMs: interval,
                }, perfNow)
                if (this.layerGuard.isDegraded(peer) !== prevDegraded) guardChanged = true
              }
            }
          }
          tState.feedbackAt = perfNow
          tState.receivedFrames = 0
          tState.receivedBytes = 0
          const remoteWantsTrack = (trackId === 2 && state.remoteSub.video === 'low')
            || (trackId === 3 && state.remoteSub.video === 'high')
            || (trackId === 4 && state.remoteSub.screen)
          if (tState.sending && remoteWantsTrack) tState.adaptation.tick(perfNow)
        }
      } else {
        // Legacy IC03 feedback
        const interval = Math.round(perfNow - state.feedbackAt)
        if (interval >= 200) {
          if (state.connected && ((state.remoteVideo || state.remoteScreen) || state.receivedFrames > 0) && interval <= 5000) {
            this.send(peer, {
              type: 'feedback', feedback_seq: state.feedbackSequence++ >>> 0,
              video_seq: state.receiver.highestVideo, received_frames: state.receivedFrames,
              received_bytes: state.receivedBytes, interval_ms: interval,
            })
          }
          state.feedbackAt = perfNow; state.receivedFrames = 0; state.receivedBytes = 0
        }
        if (this.sendingVideo() && state.videoSending && state.connected) state.adaptation.tick(perfNow)
      }

      if ((!state.connected && perfNow >= state.initiateAfter) || (state.connected && this.tickCount % 5 === 0)) {
        if (this.v4Enabled) {
          this.sendHello(peer)
          if (state.connected && state.ackedKeyEpoch !== (this.keyRing?.currentEpoch ?? 0)) this.sendSenderKeyTo(peer)
        } else this.sendBytes(peer, helloPayload ??= this.packet({ type: 'hello', state: this.state }))
      }
      if (!state.failed && wallNow - state.heard > 15000) {
        state.connected = false
        state.failed = true
        this.topology?.markHelperUnhealthy(peer, perfNow)
        this.callbacks.failed?.(peer)
        if (this.v4Enabled) {
          this.syncSubscriptions()
          this.recomputeDemand()
        }
      }
    }

    if (guardChanged) this.syncSubscriptions()
    this.updateBitrate()
  }

  async close() {
    if (this.stopped) return
    const leaving = this.sendLeave()
    this.stopped = true
    clearInterval(this.timer)
    if (this.nackTimer !== undefined) clearInterval(this.nackTimer)
    this.unregister()
    this.pending.clear()
    this.peers.clear()
    this.tagToPeer.clear()
    this.forwarderDemand.clear()
    this.lastForwarderSubSent.clear()
    this.lastForwarderEntries.clear()
    this.lastDirectSubSent.clear()
    this.retransmitCache.clear()
    this.retransmitBytes = 0
    this.pendingV4Keys.clear()
    this.embeddedForwarder?.clear()
    this.keyRing?.clear()
    if (!leaving.length) return
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([Promise.allSettled(leaving), new Promise<void>(resolve => { deadline = setTimeout(resolve, 500) })])
    } finally { clearTimeout(deadline) }
  }
}
