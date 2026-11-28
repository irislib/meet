import {
  FLAG_DISCARDABLE,
  FLAG_KEYFRAME,
  TRACK_AUDIO,
  peekCallV4Header,
  roomTagsEqual,
  type CallV4Nack,
  type TrackId,
} from './callProtocolV4'

export interface ForwarderSubscriptionEntry {
  senderTag: number
  senderPeer?: string
  tracks: readonly TrackId[]
}

export interface CallForwarderOptions {
  roomTag: Uint8Array
  sendDatagram: (dst: string, payload: Uint8Array) => Promise<void>
  onUpstreamDemand?: (senderTag: number, tracks: readonly TrackId[]) => void
  onKeyframeNeeded?: (senderTag: number, trackId: TrackId) => void
  cacheTtlMs?: number
  maxCacheBytes?: number
  maxCachePackets?: number
  maxSubscriberQueuePackets?: number
  keyframeCooldownMs?: number
}

export interface CallForwarderStats {
  inPackets: number
  inBytes: number
  outPackets: number
  outBytes: number
  nacksServedLocally: number
  droppedDiscardable: number
  droppedBackpressure: number
  keyframesCoalesced: number
  cachePackets: number
  cacheBytes: number
}

interface CachedDatagram {
  createdAt: number
  payload: Uint8Array
}

/**
 * Blind selective forwarding unit (SFU) for IC04 datagrams.
 * Holds zero media keys and performs zero decryption/transcoding.
 * Runs identically in a standalone FIPS relay node or embedded in a capable desktop participant.
 */
export class CallForwarder {
  private readonly roomTag: Uint8Array
  private readonly sendDatagram: (dst: string, payload: Uint8Array) => Promise<void>
  private readonly onUpstreamDemand?: (senderTag: number, tracks: readonly TrackId[]) => void
  private readonly onKeyframeNeeded?: (senderTag: number, trackId: TrackId) => void
  private readonly cacheTtlMs: number
  private readonly maxCacheBytes: number
  private readonly maxCachePackets: number
  private readonly maxSubscriberQueuePackets: number
  private readonly keyframeCooldownMs: number

  // subscriberPeer -> Map<senderTag, Set<TrackId>>
  private subscriberWants = new Map<string, Map<number, Set<TrackId>>>()
  // "senderTag:trackId" -> Set<subscriberPeer>
  private routes = new Map<string, Set<string>>()
  // senderTag -> sorted TrackId[] currently demanded upstream
  private upstream = new Map<number, TrackId[]>()

  // Bounded raw datagram cache for local hop-by-hop NACK repair.
  // key: "senderTag:trackId:seq:fragIndex"
  private cache = new Map<string, CachedDatagram>()
  private cacheBytes = 0

  // Per-subscriber bounded video send queue (so multi-fragment frames never self-drop behind frag 0).
  private videoQueues = new Map<string, Uint8Array[]>()
  private videoPumping = new Set<string>()
  private lastKeyframeAt = new Map<string, number>()

  private metrics: Omit<CallForwarderStats, 'cachePackets' | 'cacheBytes'> = {
    inPackets: 0,
    inBytes: 0,
    outPackets: 0,
    outBytes: 0,
    nacksServedLocally: 0,
    droppedDiscardable: 0,
    droppedBackpressure: 0,
    keyframesCoalesced: 0,
  }

  constructor(options: CallForwarderOptions) {
    this.roomTag = options.roomTag
    this.sendDatagram = options.sendDatagram
    this.onUpstreamDemand = options.onUpstreamDemand
    this.onKeyframeNeeded = options.onKeyframeNeeded
    this.cacheTtlMs = options.cacheTtlMs ?? 250
    this.maxCacheBytes = options.maxCacheBytes ?? 2 * 1024 * 1024
    this.maxCachePackets = options.maxCachePackets ?? 2048
    this.maxSubscriberQueuePackets = options.maxSubscriberQueuePackets ?? 128
    this.keyframeCooldownMs = options.keyframeCooldownMs ?? 500
  }

  stats(): CallForwarderStats {
    return {
      ...this.metrics,
      cachePackets: this.cache.size,
      cacheBytes: this.cacheBytes,
    }
  }

  upstreamTracks(senderTag: number): TrackId[] {
    return [...(this.upstream.get(senderTag >>> 0) ?? [])]
  }

  subscribersFor(senderTag: number, trackId: TrackId): string[] {
    return [...(this.routes.get(`${senderTag >>> 0}:${trackId}`) ?? [])]
  }

  setSubscriptions(subscriberPeer: string, entries: readonly ForwarderSubscriptionEntry[]) {
    const affectedSenders = new Set<number>()
    const previous = this.subscriberWants.get(subscriberPeer)
    if (previous) {
      for (const [senderTag, tracks] of previous) {
        affectedSenders.add(senderTag)
        for (const trackId of tracks) {
          const key = `${senderTag}:${trackId}`
          const set = this.routes.get(key)
          set?.delete(subscriberPeer)
          if (set && set.size === 0) this.routes.delete(key)
        }
      }
    }

    const next = new Map<number, Set<TrackId>>()
    for (const entry of entries) {
      const tag = entry.senderTag >>> 0
      if (!entry.tracks.length) continue
      affectedSenders.add(tag)
      let set = next.get(tag)
      if (!set) {
        set = new Set<TrackId>()
        next.set(tag, set)
      }
      for (const trackId of entry.tracks) {
        set.add(trackId)
        const key = `${tag}:${trackId}`
        let peers = this.routes.get(key)
        if (!peers) {
          peers = new Set<string>()
          this.routes.set(key, peers)
        }
        peers.add(subscriberPeer)
      }
    }

    if (next.size > 0) this.subscriberWants.set(subscriberPeer, next)
    else this.subscriberWants.delete(subscriberPeer)

    this.reconcileUpstream(affectedSenders)
  }

  removeSubscriber(subscriberPeer: string) {
    this.setSubscriptions(subscriberPeer, [])
    this.videoQueues.delete(subscriberPeer)
    this.videoPumping.delete(subscriberPeer)
  }

  private reconcileUpstream(senders: Iterable<number>) {
    for (const senderTag of senders) {
      const tracks: TrackId[] = []
      for (const trackId of [1, 2, 3, 4] as const) {
        const subs = this.routes.get(`${senderTag}:${trackId}`)
        if (subs && subs.size > 0) tracks.push(trackId)
      }
      const prev = this.upstream.get(senderTag) ?? []
      const changed = prev.length !== tracks.length || prev.some((t, i) => t !== tracks[i])
      if (!changed) continue
      if (tracks.length > 0) this.upstream.set(senderTag, tracks)
      else this.upstream.delete(senderTag)
      this.onUpstreamDemand?.(senderTag, tracks)
    }
  }

  private pruneCache(now: number) {
    for (const [key, item] of this.cache) {
      if (now - item.createdAt > this.cacheTtlMs) {
        this.cache.delete(key)
        this.cacheBytes -= item.payload.byteLength
      } else {
        break
      }
    }
    while (this.cache.size > this.maxCachePackets || this.cacheBytes > this.maxCacheBytes) {
      const oldest = this.cache.entries().next().value as [string, CachedDatagram] | undefined
      if (!oldest) break
      this.cache.delete(oldest[0])
      this.cacheBytes -= oldest[1].payload.byteLength
    }
  }

  private rememberPacket(senderTag: number, trackId: TrackId, seq: number, fragIndex: number, payload: Uint8Array, now: number) {
    this.pruneCache(now)
    const key = `${senderTag >>> 0}:${trackId}:${seq >>> 0}:${fragIndex}`
    if (this.cache.has(key)) return
    this.cache.set(key, { createdAt: now, payload })
    this.cacheBytes += payload.byteLength
    this.pruneCache(now)
  }

  /** Coalesces bursts of downstream keyframe requests into bounded upstream PLIs. */
  handleKeyframeRequest(senderTag: number, trackId: TrackId, now = performance.now()): boolean {
    const key = `${senderTag >>> 0}:${trackId}`
    const last = this.lastKeyframeAt.get(key)
    if (last !== undefined && now - last < this.keyframeCooldownMs) {
      this.metrics.keyframesCoalesced++
      return false
    }
    this.lastKeyframeAt.set(key, now)
    this.onKeyframeNeeded?.(senderTag >>> 0, trackId)
    return true
  }

  /** Answers downstream fragment NACKs directly from local cache without hitting the publisher. */
  async handleNack(subscriberPeer: string, nack: CallV4Nack, now = performance.now()): Promise<number> {
    this.pruneCache(now)
    const route = this.routes.get(`${nack.senderTag >>> 0}:${nack.trackId}`)
    if (!route || !route.has(subscriberPeer)) return 0
    let sent = 0
    for (const fragIndex of nack.missing) {
      const key = `${nack.senderTag >>> 0}:${nack.trackId}:${nack.seq >>> 0}:${fragIndex}`
      const cached = this.cache.get(key)
      if (!cached) continue
      try {
        await this.sendDatagram(subscriberPeer, cached.payload)
        sent++
        this.metrics.nacksServedLocally++
        this.metrics.outPackets++
        this.metrics.outBytes += cached.payload.byteLength
      } catch {
        break
      }
    }
    return sent
  }

  /** Zero-copy blind datagram forwarding with audio priority and discardable-frame dropping. */
  async ingestDatagram(fromPeer: string, packet: Uint8Array, now = performance.now()): Promise<number> {
    const header = peekCallV4Header(packet)
    if (!header || !roomTagsEqual(header.roomTag, this.roomTag)) return 0
    this.metrics.inPackets++
    this.metrics.inBytes += packet.byteLength

    if (header.trackId !== TRACK_AUDIO) {
      this.rememberPacket(header.senderTag, header.trackId, header.seq, header.fragIndex, packet, now)
    }

    const route = this.routes.get(`${header.senderTag >>> 0}:${header.trackId}`)
    if (!route || route.size === 0) return 0

    const isAudio = header.trackId === TRACK_AUDIO
    const isKeyframe = (header.flags & FLAG_KEYFRAME) !== 0
    const isDiscardable = (header.flags & FLAG_DISCARDABLE) !== 0

    let forwarded = 0
    const jobs: Promise<void>[] = []
    for (const dst of route) {
      // Loop prevention: never echo back to ingress peer.
      if (dst === fromPeer) continue

      if (isAudio) {
        // Audio is always prioritized and never stalled behind video queues.
        forwarded++
        this.metrics.outPackets++
        this.metrics.outBytes += packet.byteLength
        jobs.push(this.sendDatagram(dst, packet).catch(() => {}))
        continue
      }

      const queue = this.videoQueues.get(dst) ?? []
      if (!this.videoQueues.has(dst)) this.videoQueues.set(dst, queue)
      const busy = this.videoPumping.has(dst)
      const aqmThreshold = Math.max(0, Math.floor(this.maxSubscriberQueuePackets * 0.6))

      // Active queue management under real subscriber congestion:
      // 1) Shed discardable temporal frames first; 2) shed deltas when full; 3) always preserve keyframes.
      if (busy && isDiscardable && queue.length >= aqmThreshold) {
        this.metrics.droppedDiscardable++
        continue
      }
      if (busy && !isKeyframe && queue.length >= this.maxSubscriberQueuePackets) {
        this.metrics.droppedBackpressure++
        continue
      }
      if (isKeyframe && queue.length >= this.maxSubscriberQueuePackets * 2) {
        queue.shift()
      }

      forwarded++
      queue.push(packet)
      if (!this.videoPumping.has(dst)) {
        this.videoPumping.add(dst)
        jobs.push((async () => {
          try {
            while (queue.length > 0 && this.subscriberWants.has(dst)) {
              const next = queue.shift()!
              this.metrics.outPackets++
              this.metrics.outBytes += next.byteLength
              await this.sendDatagram(dst, next)
            }
          } catch {
            // Per-subscriber failure must never stall other subscribers.
          } finally {
            this.videoPumping.delete(dst)
          }
        })())
      }
    }

    if (jobs.length) await Promise.allSettled(jobs)
    return forwarded
  }

  clear() {
    this.subscriberWants.clear()
    this.routes.clear()
    this.upstream.clear()
    this.cache.clear()
    this.cacheBytes = 0
    this.videoQueues.clear()
    this.videoPumping.clear()
    this.lastKeyframeAt.clear()
  }
}
