import { CallForwarder, type CallForwarderStats, type ForwarderSubscriptionEntry } from './callForwarder'
import {
  computeRoomTag,
  isCallV4Packet,
  isValidTrackId,
  senderTagFromPeer,
  type CallV4Nack,
  type TrackId,
} from './callProtocolV4'
import { authenticatedMeetingPeer, canonicalPeer, MEETING_PORT, type MeetingEndpoint } from './meetingTransport'

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export interface BlindForwarderServiceOptions {
  endpoint: MeetingEndpoint
  room: string
  maxFanout?: number
  uplinkKbps?: number
}

/**
 * Headless blind selective forwarding service over authenticated FIPS datagrams.
 * Holds zero media keys, zero room secret, and zero codecs.
 * Can run in a standalone FIPS relay process or inside a desktop participant.
 */
export class BlindForwarderService {
  private readonly roomTag: Uint8Array
  private readonly forwarder: CallForwarder
  private readonly unregister: () => void
  private readonly maxFanout: number
  private readonly uplinkKbps: number
  // senderTag -> canonical peer address (learned from authenticated FIPS peer IDs)
  private senderPeers = new Map<number, string>()
  private peers = new Set<string>()
  private stopped = false

  constructor(private readonly options: BlindForwarderServiceOptions) {
    this.roomTag = computeRoomTag(options.room)
    this.maxFanout = options.maxFanout ?? 64
    this.uplinkKbps = options.uplinkKbps ?? 200_000
    this.forwarder = new CallForwarder({
      roomTag: this.roomTag,
      sendDatagram: (dst, payload) => options.endpoint.sendDatagram({
        dst, srcPort: MEETING_PORT, dstPort: MEETING_PORT, payload,
      }),
      onUpstreamDemand: (senderTag, tracks) => {
        const sender = this.senderPeers.get(senderTag >>> 0)
        if (sender && !this.stopped) {
          this.sendControl(sender, { type: 'fwd_demand', senderTag: senderTag >>> 0, tracks: [...tracks] })
        }
      },
      onKeyframeNeeded: (senderTag, trackId) => {
        const sender = this.senderPeers.get(senderTag >>> 0)
        if (sender && !this.stopped) {
          this.sendControl(sender, { type: 'keyframe_v4', senderTag: senderTag >>> 0, trackId })
        }
      },
    })
    this.unregister = options.endpoint.registerService(MEETING_PORT, ({ peerId, src, payload }) => {
      const peer = authenticatedMeetingPeer(src, peerId)
      if (!peer || this.stopped) return
      void this.receive(peer, payload)
    })
  }

  stats(): CallForwarderStats {
    return this.forwarder.stats()
  }

  upstreamTracks(senderPeer: string): TrackId[] {
    return this.forwarder.upstreamTracks(senderTagFromPeer(canonicalPeer(senderPeer)))
  }

  private sendControl(dst: string, data: object) {
    if (this.stopped) return
    const payload = encoder.encode(JSON.stringify({ v: 1, room: this.options.room, ...data }))
    void this.options.endpoint.sendDatagram({ dst, srcPort: MEETING_PORT, dstPort: MEETING_PORT, payload }).catch(() => {})
  }

  private async receive(peer: string, payload: Uint8Array) {
    const tag = senderTagFromPeer(peer)
    this.senderPeers.set(tag, peer)
    this.peers.add(peer)

    if (isCallV4Packet(payload)) {
      await this.forwarder.ingestDatagram(peer, payload)
      return
    }
    if (payload.length > 2048) return
    let msg: any
    try { msg = JSON.parse(decoder.decode(payload)) } catch { return }
    if (msg.v !== 1 || msg.room !== this.options.room) return

    switch (msg.type) {
      case 'fwd_hello': {
        this.sendControl(peer, {
          type: 'fwd_welcome',
          dedicated: true,
          maxFanout: this.maxFanout,
          uplinkKbps: this.uplinkKbps,
        })
        // Re-notify upstream demand if subscribers already want this sender's tracks.
        const tracks = this.forwarder.upstreamTracks(tag)
        if (tracks.length) {
          this.sendControl(peer, { type: 'fwd_demand', senderTag: tag, tracks })
        }
        break
      }
      case 'fwd_sub': {
        if (!Array.isArray(msg.entries)) return
        const entries: ForwarderSubscriptionEntry[] = []
        const newlyLearned: Array<{ tag: number; peer: string }> = []
        for (const item of msg.entries) {
          if (typeof item?.senderTag !== 'number' || !Array.isArray(item.tracks)) continue
          const tag = item.senderTag >>> 0
          if (typeof item.senderPeer === 'string') {
            const sp = canonicalPeer(item.senderPeer)
            if (sp && senderTagFromPeer(sp) === tag && !this.senderPeers.has(tag)) {
              this.senderPeers.set(tag, sp)
              newlyLearned.push({ tag, peer: sp })
            }
          }
          const tracks = item.tracks.filter((t: unknown): t is TrackId => typeof t === 'number' && isValidTrackId(t))
          entries.push({ senderTag: tag, tracks })
        }
        this.forwarder.setSubscriptions(peer, entries)
        for (const { tag, peer: sp } of newlyLearned) {
          const tracks = this.forwarder.upstreamTracks(tag)
          if (tracks.length) this.sendControl(sp, { type: 'fwd_demand', senderTag: tag, tracks })
        }
        break
      }
      case 'nack_v4': {
        if (typeof msg.senderTag !== 'number' || !isValidTrackId(msg.trackId) || typeof msg.seq !== 'number' || !Array.isArray(msg.missing)) return
        const nack: CallV4Nack = {
          senderTag: msg.senderTag >>> 0,
          trackId: msg.trackId,
          seq: msg.seq >>> 0,
          missing: msg.missing.filter((i: unknown): i is number => typeof i === 'number' && Number.isInteger(i) && i >= 0).slice(0, 64),
        }
        await this.forwarder.handleNack(peer, nack)
        break
      }
      case 'keyframe_v4': {
        if (typeof msg.senderTag !== 'number' || !isValidTrackId(msg.trackId)) return
        this.forwarder.handleKeyframeRequest(msg.senderTag >>> 0, msg.trackId)
        break
      }
      case 'leave': {
        this.forwarder.removeSubscriber(peer)
        this.peers.delete(peer)
        break
      }
    }
  }

  close() {
    if (this.stopped) return
    this.stopped = true
    this.unregister()
    this.forwarder.clear()
    this.senderPeers.clear()
    this.peers.clear()
  }
}
