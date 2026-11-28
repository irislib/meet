import { describe, expect, it } from 'vitest'
import {
  ReceiverLayerGuard,
  aggregatePublisherDemand,
  computeViewportSubscriptions,
  type PeerSubscription,
} from './callSubscriptions'
import { TRACK_AUDIO, TRACK_SCREEN, TRACK_VIDEO_HIGH, TRACK_VIDEO_LOW } from './callProtocolV4'

describe('receiver-driven viewport subscriptions and demand propagation', () => {
  it('subscribes HD in small rooms (<=4 total), thumbnails in larger grids, and caps video decoders', () => {
    const small = computeViewportSubscriptions({
      peers: [
        { peer: 'p1', videoEnabled: true, screenSharing: false },
        { peer: 'p2', videoEnabled: true, screenSharing: false },
      ],
      focusedPeer: null,
      maxVideoDecoders: 8,
    })
    expect(small.get('p1')).toEqual({ audio: true, video: 'high', screen: false })
    expect(small.get('p2')).toEqual({ audio: true, video: 'high', screen: false })

    // 10 remote peers (11 total) with 4-decoder cap (e.g. mobile): only 4 get low video, rest get audio-only.
    const largePeers = Array.from({ length: 10 }, (_, i) => ({
      peer: `p${i}`, videoEnabled: true, screenSharing: false,
    }))
    const large = computeViewportSubscriptions({
      peers: largePeers,
      focusedPeer: null,
      maxVideoDecoders: 4,
    })
    const videoLayers = [...large.values()].map(s => s.video)
    expect(videoLayers.filter(v => v === 'high')).toHaveLength(0)
    expect(videoLayers.filter(v => v === 'low')).toHaveLength(4)
    expect(videoLayers.filter(v => v === 'none')).toHaveLength(6)
    expect([...large.values()].every(s => s.audio)).toBe(true)

    // Focusing p7 upgrades ONLY p7 to high, keeps 3 others at low, and others at none.
    const focused = computeViewportSubscriptions({
      peers: largePeers,
      focusedPeer: 'p7',
      maxVideoDecoders: 4,
    })
    expect(focused.get('p7')?.video).toBe('high')
    expect([...focused.values()].filter(v => v.video === 'high')).toHaveLength(1)
    expect([...focused.values()].filter(v => v.video === 'low')).toHaveLength(3)
    expect([...focused.values()].filter(v => v.video === 'none')).toHaveLength(6)
  })

  it('subscribes independent screen track without losing camera preference', () => {
    const subs = computeViewportSubscriptions({
      peers: [{ peer: 'p1', videoEnabled: true, screenSharing: true }],
      focusedPeer: 'p1',
      maxVideoDecoders: 6,
    })
    expect(subs.get('p1')).toEqual({ audio: true, video: 'low', screen: true })
  })

  it('propagates viewer demand back to publisher and stops HD encoder when last HD viewer unpins', () => {
    const subs = new Map<string, PeerSubscription>([
      ['viewerA', { audio: true, video: 'high', screen: false }],
      ['viewerB', { audio: true, video: 'low', screen: false }],
    ])
    const d1 = aggregatePublisherDemand(subs)
    expect(d1.wantHigh).toBe(true)
    expect(d1.wantLow).toBe(true)
    expect(d1.highTargets).toEqual(['viewerA'])
    expect(d1.lowTargets).toEqual(['viewerB'])
    expect(d1.tracksForPeer('viewerA')).toEqual([TRACK_AUDIO, TRACK_VIDEO_HIGH])
    expect(d1.tracksForPeer('viewerB')).toEqual([TRACK_AUDIO, TRACK_VIDEO_LOW])

    // ViewerA unpins HD -> switches to low -> publisher stops HD encoder!
    subs.set('viewerA', { audio: true, video: 'low', screen: false })
    const d2 = aggregatePublisherDemand(subs)
    expect(d2.wantHigh).toBe(false)
    expect(d2.wantLow).toBe(true)
    expect(d2.highTargets).toEqual([])
    expect(d2.lowTargets).toEqual(['viewerA', 'viewerB'])

    // Both viewers hide video -> publisher stops all video encoders!
    subs.set('viewerA', { audio: true, video: 'none', screen: false })
    subs.set('viewerB', { audio: true, video: 'none', screen: false })
    const d3 = aggregatePublisherDemand(subs)
    expect(d3.wantHigh).toBe(false)
    expect(d3.wantLow).toBe(false)
    expect(d3.wantAudio).toBe(true)

    // Screen subscription activates screen track independently.
    subs.set('viewerA', { audio: true, video: 'none', screen: true })
    const d4 = aggregatePublisherDemand(subs)
    expect(d4.wantScreen).toBe(true)
    expect(d4.tracksForPeer('viewerA')).toEqual([TRACK_AUDIO, TRACK_SCREEN])
  })

  it('downgrades only the congested receiver from high to low and recovers after sustained stability', () => {
    const guard = new ReceiverLayerGuard({ downgradeLossRatio: 0.12, recoverHealthyMs: 6000 })
    // Healthy reception on high stays high.
    expect(guard.report('alice', 'high', { expected: 30, received: 30, intervalMs: 1000 }, 1000)).toBe('high')
    // Heavy loss triggers local downgrade to low without affecting other receivers.
    expect(guard.report('alice', 'high', { expected: 30, received: 18, intervalMs: 1000 }, 2000)).toBe('low')
    expect(guard.isDegraded('alice')).toBe(true)
    // Stays on low during recovery window.
    for (let t = 3000; t <= 7000; t += 1000) {
      expect(guard.report('alice', 'low', { expected: 15, received: 15, intervalMs: 1000 }, t)).toBe('low')
    }
    // After 6s healthy on low, probes back to high!
    expect(guard.report('alice', 'low', { expected: 15, received: 15, intervalMs: 1000 }, 8000)).toBe('high')
    expect(guard.isDegraded('alice')).toBe(false)
  })
})
