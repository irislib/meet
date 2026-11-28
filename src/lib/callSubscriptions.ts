import {
  TRACK_AUDIO,
  TRACK_SCREEN,
  TRACK_VIDEO_HIGH,
  TRACK_VIDEO_LOW,
  type TrackId,
} from './callProtocolV4'

export type VideoLayer = 'none' | 'low' | 'high'

export interface PeerSubscription {
  audio: boolean
  video: VideoLayer
  screen: boolean
}

export interface ViewportPeer {
  peer: string
  videoEnabled: boolean
  screenSharing: boolean
}

export interface ViewportSubscriptionInput {
  peers: readonly ViewportPeer[]
  focusedPeer: string | null
  maxVideoDecoders?: number
  degradedPeers?: ReadonlySet<string>
  overrides?: ReadonlyMap<string, Partial<PeerSubscription>>
}

export function subscriptionToTracks(sub: PeerSubscription): TrackId[] {
  const tracks: TrackId[] = []
  if (sub.audio) tracks.push(TRACK_AUDIO)
  if (sub.video === 'low') tracks.push(TRACK_VIDEO_LOW)
  else if (sub.video === 'high') tracks.push(TRACK_VIDEO_HIGH)
  if (sub.screen) tracks.push(TRACK_SCREEN)
  return tracks
}

export function tracksToSubscription(tracks: readonly TrackId[]): PeerSubscription {
  const hasHigh = tracks.includes(TRACK_VIDEO_HIGH)
  const hasLow = tracks.includes(TRACK_VIDEO_LOW)
  return {
    audio: tracks.includes(TRACK_AUDIO),
    video: hasHigh ? 'high' : hasLow ? 'low' : 'none',
    screen: tracks.includes(TRACK_SCREEN),
  }
}

export function subscriptionsEqual(a: PeerSubscription | undefined, b: PeerSubscription | undefined): boolean {
  if (!a || !b) return a === b
  return a.audio === b.audio && a.video === b.video && a.screen === b.screen
}

/**
 * Computes receiver-driven track/layer subscriptions from UI layout and hardware decoder budget.
 * - Preserves overlapping speech (audio=true for every connected participant; Opus DTX handles silence).
 * - Small rooms (<=4 total) subscribe HD by default; larger grids subscribe thumbnails (low) unless focused.
 * - Caps concurrent video/screen decoders to avoid mobile hardware decoder exhaustion.
 */
export function computeViewportSubscriptions(input: ViewportSubscriptionInput): Map<string, PeerSubscription> {
  const { peers, focusedPeer, maxVideoDecoders = 9, degradedPeers, overrides } = input
  const result = new Map<string, PeerSubscription>()
  const totalParticipants = peers.length + 1
  const smallRoom = totalParticipants <= 4

  // Order peers so focused & screen-sharing peers claim decoder budget first.
  const ordered = [...peers].sort((a, b) => {
    const aFocus = a.peer === focusedPeer ? 0 : 1
    const bFocus = b.peer === focusedPeer ? 0 : 1
    if (aFocus !== bFocus) return aFocus - bFocus
    const aScreen = a.screenSharing ? 0 : 1
    const bScreen = b.screenSharing ? 0 : 1
    if (aScreen !== bScreen) return aScreen - bScreen
    const aVideo = a.videoEnabled ? 0 : 1
    const bVideo = b.videoEnabled ? 0 : 1
    return aVideo - bVideo
  })

  let decodersUsed = 0
  for (const item of ordered) {
    const override = overrides?.get(item.peer)
    const degraded = degradedPeers?.has(item.peer) ?? false
    const isFocused = item.peer === focusedPeer

    let screen = false
    let video: VideoLayer = 'none'

    if (item.screenSharing && decodersUsed < maxVideoDecoders) {
      screen = true
      decodersUsed++
      if (item.videoEnabled && isFocused && decodersUsed < maxVideoDecoders) {
        video = 'low'
        decodersUsed++
      }
    } else if (item.videoEnabled && decodersUsed < maxVideoDecoders) {
      const wantsHigh = isFocused || (!focusedPeer && smallRoom)
      video = wantsHigh && !degraded ? 'high' : 'low'
      decodersUsed++
    }

    const sub: PeerSubscription = {
      audio: override?.audio ?? true,
      video: override?.video ?? video,
      screen: override?.screen ?? screen,
    }
    result.set(item.peer, sub)
  }

  return result
}

export interface PublisherDemand {
  wantAudio: boolean
  wantLow: boolean
  wantHigh: boolean
  wantScreen: boolean
  audioTargets: string[]
  lowTargets: string[]
  highTargets: string[]
  screenTargets: string[]
  tracksForPeer(peer: string): TrackId[]
}

/** Aggregates all remote subscribers' demand so unused encoders (e.g. HD) can be stopped cleanly. */
export function aggregatePublisherDemand(subs: ReadonlyMap<string, PeerSubscription>): PublisherDemand {
  const audioTargets: string[] = []
  const lowTargets: string[] = []
  const highTargets: string[] = []
  const screenTargets: string[] = []

  for (const [peer, sub] of subs) {
    if (sub.audio) audioTargets.push(peer)
    if (sub.video === 'low') lowTargets.push(peer)
    else if (sub.video === 'high') highTargets.push(peer)
    if (sub.screen) screenTargets.push(peer)
  }

  return {
    wantAudio: audioTargets.length > 0,
    wantLow: lowTargets.length > 0,
    wantHigh: highTargets.length > 0,
    wantScreen: screenTargets.length > 0,
    audioTargets,
    lowTargets,
    highTargets,
    screenTargets,
    tracksForPeer(peer: string): TrackId[] {
      const sub = subs.get(peer)
      return sub ? subscriptionToTracks(sub) : []
    },
  }
}

export interface LayerHealthSample {
  expected: number
  received: number
  intervalMs: number
}

interface GuardState {
  degraded: boolean
  healthyMs: number
  badWindows: number
  lastUpdate: number
}

/**
 * Per-receiver adaptive layer guard.
 * When a single receiver's link degrades on HD, it switches itself to low without affecting healthy receivers.
 */
export class ReceiverLayerGuard {
  private readonly downgradeLossRatio: number
  private readonly recoverHealthyMs: number
  private states = new Map<string, GuardState>()

  constructor(options: { downgradeLossRatio?: number; recoverHealthyMs?: number } = {}) {
    this.downgradeLossRatio = options.downgradeLossRatio ?? 0.12
    this.recoverHealthyMs = options.recoverHealthyMs ?? 6000
  }

  isDegraded(peer: string): boolean {
    return this.states.get(peer)?.degraded ?? false
  }

  degradedSet(): Set<string> {
    const out = new Set<string>()
    for (const [peer, state] of this.states) if (state.degraded) out.add(peer)
    return out
  }

  removePeer(peer: string) {
    this.states.delete(peer)
  }

  clear() {
    this.states.clear()
  }

  report(peer: string, currentLayer: VideoLayer, sample: LayerHealthSample, now = performance.now()): VideoLayer {
    if (currentLayer === 'none') return 'none'
    let state = this.states.get(peer)
    if (!state) {
      state = { degraded: false, healthyMs: 0, badWindows: 0, lastUpdate: now }
      this.states.set(peer, state)
    }
    state.lastUpdate = now
    const expected = Math.max(0, sample.expected)
    const received = Math.max(0, sample.received)
    const loss = expected > 0 ? Math.max(0, expected - received) / expected : (received === 0 ? 1 : 0)

    if (currentLayer === 'high') {
      if (loss > this.downgradeLossRatio || (expected >= 5 && received === 0)) {
        state.degraded = true
        state.healthyMs = 0
        state.badWindows++
        return 'low'
      }
      state.badWindows = 0
      return 'high'
    }

    // Currently on low while viewport may prefer high: track sustained healthy reception to recover.
    if (state.degraded) {
      if (loss <= 0.03 && received > 0) {
        state.healthyMs += Math.max(0, sample.intervalMs)
        if (state.healthyMs >= this.recoverHealthyMs) {
          state.degraded = false
          state.healthyMs = 0
          return 'high'
        }
      } else {
        state.healthyMs = 0
      }
      return 'low'
    }

    return currentLayer
  }
}
