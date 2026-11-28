export type CallTopologyMode = 'mesh' | 'assisted'

export interface PeerCapability {
  peer: string
  /** True only when a direct WebRTC/UDP FIPS path is established (not a seed detour). */
  direct: boolean
  /** Measured round-trip latency in ms. */
  rttMs: number
  /** Estimated available upload headroom in kbps. */
  uplinkKbps: number
  /** Phones/tablets are excluded from forwarding duties by default. */
  mobile: boolean
  /** Background/hidden tabs are excluded from forwarding duties by default. */
  background: boolean
  /** Dedicated headless blind forwarder (e.g. self-hosted or community FIPS SFU). */
  dedicated: boolean
  /** Maximum concurrent downstream leaves this peer is willing to serve. */
  maxFanout: number
}

export interface SenderHelperRoute {
  mode: CallTopologyMode
  primary?: string
  standby?: string
}

const UNHEALTHY_COOLDOWN_MS = 15_000
const MESH_MAX_PEERS = 4

function scoreCapability(cap: PeerCapability): number {
  const dedicatedBonus = cap.dedicated ? 1_000_000_000 : 0
  const uplinkScore = Math.min(cap.uplinkKbps, 1_000_000) * 10
  const fanoutScore = Math.min(cap.maxFanout, 200) * 500
  const latencyPenalty = Math.min(cap.rttMs, 1000) * 20
  return dedicatedBonus + uplinkScore + fanoutScore - latencyPenalty
}

function stableHash(value: string): number {
  let h = 2166136261
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  // Murmur3 fmix32 finalizer for full avalanche on short peer IDs.
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/**
 * Route-aware topology controller.
 * - Keeps direct 1-hop mesh for small rooms (<=4 total) unless a dedicated blind forwarder is configured.
 * - Elects only direct-connected, foreground desktop peers (or dedicated blind SFUs) as helpers.
 * - Shards active senders across multiple top helpers and assigns a deterministic warm standby for fast failover.
 */
export class CallTopology {
  private capabilities = new Map<string, PeerCapability>()
  private unhealthyUntil = new Map<string, number>()

  constructor(private readonly localPeer: string) {}

  updateCapability(cap: PeerCapability) {
    this.capabilities.set(cap.peer, { ...cap })
  }

  removePeer(peer: string) {
    this.capabilities.delete(peer)
    this.unhealthyUntil.delete(peer)
  }

  markHelperUnhealthy(peer: string, now = performance.now()) {
    this.unhealthyUntil.set(peer, now + UNHEALTHY_COOLDOWN_MS)
  }

  clearUnhealthy(peer: string) {
    this.unhealthyUntil.delete(peer)
  }

  peerCount(): number {
    return this.capabilities.size
  }

  eligibleHelpers(now = performance.now()): string[] {
    const candidates: PeerCapability[] = []
    for (const cap of this.capabilities.values()) {
      const blockedUntil = this.unhealthyUntil.get(cap.peer)
      if (blockedUntil !== undefined && now < blockedUntil) continue
      if (cap.dedicated) {
        if (cap.maxFanout >= 2) candidates.push(cap)
        continue
      }
      if (!cap.direct || cap.mobile || cap.background || cap.maxFanout < 2) continue
      candidates.push(cap)
    }
    candidates.sort((a, b) => {
      const diff = scoreCapability(b) - scoreCapability(a)
      if (diff !== 0) return diff
      return a.peer < b.peer ? -1 : a.peer > b.peer ? 1 : 0
    })
    return candidates.map(c => c.peer)
  }

  hasDedicatedForwarder(now = performance.now()): boolean {
    return this.eligibleHelpers(now).some(peer => this.capabilities.get(peer)?.dedicated)
  }

  mode(now = performance.now()): CallTopologyMode {
    if (this.hasDedicatedForwarder(now)) return 'assisted'
    if (this.capabilities.size <= MESH_MAX_PEERS) return 'mesh'
    return this.eligibleHelpers(now).length > 0 ? 'assisted' : 'mesh'
  }

  /**
   * Selects a deterministic primary + warm standby helper for a given sender using
   * Rendezvous (HRW) hashing over the top helper tier. When the primary fails,
   * the exact warm standby is promoted without reshuffling unrelated senders.
   */
  routeForSender(senderPeer: string, senderTag: number, now = performance.now()): SenderHelperRoute {
    const currentMode = this.mode(now)
    if (currentMode === 'mesh') return { mode: 'mesh' }

    const helpers = this.eligibleHelpers(now).filter(peer => peer !== senderPeer)
    if (!helpers.length) return { mode: 'mesh' }

    // If dedicated blind forwarder(s) exist, prefer them over participant desktops.
    const dedicated = helpers.filter(peer => this.capabilities.get(peer)?.dedicated)
    const pool = dedicated.length > 0 ? dedicated : helpers.slice(0, Math.min(helpers.length, 4))
    const ranked = [...pool].sort((a, b) => {
      const ha = stableHash(`${senderTag >>> 0}:${a}`)
      const hb = stableHash(`${senderTag >>> 0}:${b}`)
      if (hb !== ha) return hb - ha
      return a < b ? -1 : a > b ? 1 : 0
    })
    return { mode: 'assisted', primary: ranked[0], standby: ranked[1] }
  }

  /**
   * Stage mode (1 presenter + many listeners): distributes listeners evenly across top direct helpers
   * while respecting each helper's maxFanout cap so depth stays <= 2 hops and no helper overloads.
   */
  stageHelperForListener(presenterPeer: string, listenerPeer: string, now = performance.now(), maxHelpers = 4): string | undefined {
    const helpers = this.eligibleHelpers(now).filter(peer => peer !== presenterPeer && peer !== listenerPeer)
    if (!helpers.length) return undefined
    const dedicated = helpers.filter(peer => this.capabilities.get(peer)?.dedicated)
    const pool = dedicated.length > 0 ? dedicated : helpers.slice(0, Math.min(helpers.length, maxHelpers))
    const poolSet = new Set(pool)
    // Deterministic balanced assignment across known non-helper listeners.
    const listeners = [...this.capabilities.keys()]
      .filter(peer => peer !== presenterPeer && !poolSet.has(peer))
      .sort()
    if (!listeners.includes(listenerPeer)) listeners.push(listenerPeer)
    const load = new Map<string, number>(pool.map(h => [h, 0]))
    const perHelperTarget = Math.max(1, Math.ceil(listeners.length / pool.length))

    for (const listener of listeners) {
      const ranked = [...pool].sort((a, b) => {
        const ha = stableHash(`${listener}:${a}`)
        const hb = stableHash(`${listener}:${b}`)
        if (hb !== ha) return hb - ha
        return a < b ? -1 : a > b ? 1 : 0
      })
      const chosen = ranked.find(h => {
        const count = load.get(h) ?? 0
        const cap = this.capabilities.get(h)?.maxFanout ?? perHelperTarget
        return count < Math.min(perHelperTarget, cap)
      }) ?? ranked.find(h => (load.get(h) ?? 0) < (this.capabilities.get(h)?.maxFanout ?? Infinity)) ?? ranked[0]
      load.set(chosen, (load.get(chosen) ?? 0) + 1)
      if (listener === listenerPeer) return chosen
    }
    return pool[0]
  }

  /** Returns the helper set a stage presenter must upload to (at most maxHelpers). */
  stagePresenterHelpers(presenterPeer: string, now = performance.now(), maxHelpers = 4): string[] {
    const helpers = this.eligibleHelpers(now).filter(peer => peer !== presenterPeer)
    const dedicated = helpers.filter(peer => this.capabilities.get(peer)?.dedicated)
    return dedicated.length > 0 ? dedicated : helpers.slice(0, Math.min(helpers.length, maxHelpers))
  }

  get selfPeer(): string {
    return this.localPeer
  }
}
