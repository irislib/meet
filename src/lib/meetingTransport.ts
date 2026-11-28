import { CallMediaReceiver, encodeCallMedia, type MediaFrame } from './callProtocol'
import { CallAdaptation } from './callAdaptation'
import { callEncoding } from './callQuality'

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
interface Callbacks {
  heartbeat?(peer: string): void
  connected?(peer: string): void
  failed?(peer: string): void
  leave?(peer: string): void
  message?(peer: string, message: TransportChat): void
  state?(peer: string, state: MediaState): void
  media?(peer: string, frame: MediaFrame): void
  keyframe?(): void
  bitrate?(bitsPerSecond: number): void
  error?(message: string): void
}
interface Peer {
  receiver: CallMediaReceiver
  heard: number
  connected: boolean
  failed: boolean
  remoteVideo: boolean
  seen: Set<string>
  adaptation: CallAdaptation
  videoSending: boolean
  feedbackAt: number
  feedbackSequence: number
  receivedFrames: number
  receivedBytes: number
  pendingKey?: { packets: Uint8Array[]; allowed: () => boolean }
}
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

/** Group call service over authenticated FIPS datagrams, independent of the carrier. */
export class MeetingTransport {
  private peers = new Map<string, Peer>()
  private pending = new Map<string, { payload: Uint8Array; waiting: Set<string>; expires: number }>()
  private state: MediaState = { audioEnabled: false, videoEnabled: false, screenSharing: false }
  private stopped = false
  private unregister: () => void
  private timer: ReturnType<typeof setInterval>
  private tickCount = 0
  private mediaBusy = new Set<string>()
  private targetBitrate = 1_200_000
  get videoBitrate() { return this.targetBitrate }
  constructor(private endpoint: MeetingEndpoint, private room: string, private callbacks: Callbacks) {
    this.unregister = endpoint.registerService(MEETING_PORT, ({ peerId, src, payload }) => this.receive(authenticatedMeetingPeer(src, peerId), payload))
    this.timer = setInterval(() => this.tick(), 1000)
  }
  addPeer(address: string) {
    const peer = canonicalPeer(address)
    if (!peer || this.stopped || this.peers.has(peer)) return
    this.peers.set(peer, {
      receiver: new CallMediaReceiver(), heard: Date.now(), connected: false, failed: false, remoteVideo: false,
      seen: new Set(), adaptation: new CallAdaptation(callEncoding({}).maxBitrate), videoSending: false,
      feedbackAt: performance.now(), feedbackSequence: 0, receivedFrames: 0, receivedBytes: 0,
    })
    this.send(peer, { type: 'hello', state: this.state })
  }
  removePeer(address: string) {
    const peer = canonicalPeer(address)
    this.peers.delete(peer)
    for (const item of this.pending.values()) item.waiting.delete(peer)
    this.updateBitrate()
  }
  peerIds() { return [...this.peers.keys()] }
  hasPeer(address: string) { return this.peers.has(canonicalPeer(address)) }
  setState(state: MediaState) {
    if ((state.videoEnabled || state.screenSharing) && !this.sendingVideo()) {
      for (const peer of this.peers.values()) peer.adaptation.begin()
    }
    this.state = state
    const payload = this.packet({ type: 'state', state })
    for (const peer of this.peers.keys()) this.sendBytes(peer, payload)
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
  requestKeyframe(peer: string) { this.send(peer, { type: 'keyframe' }) }
  sendLeave() {
    if (this.stopped || !this.peers.size) return []
    const payload = this.packet({ type: 'leave' })
    return [...this.peers.keys()].map(dst => this.endpoint.sendDatagram({ dst, srcPort: MEETING_PORT, dstPort: MEETING_PORT, payload }))
  }
  async sendMedia(frame: MediaFrame, allowed: () => boolean = () => true) {
    if (this.stopped || !allowed()) return
    let hasConnected = false
    for (const state of this.peers.values()) { if (state.connected) { hasConnected = true; break } }
    if (!hasConnected) return
    const packets = encodeCallMedia(this.room, frame)
    if (!packets.length) return
    await Promise.allSettled([...this.peers].map(async ([peer, state]) => {
      if (!state.connected) return
      if (frame.kind === 2) {
        if (!state.videoSending) { state.videoSending = true; state.adaptation.begin() }
        state.adaptation.sentFrame(frame.seq)
      }
      const key = `${peer}:${frame.kind}`
      if (this.mediaBusy.has(key)) {
        // Never lose a keyframe behind a slow delta frame; deliver it as soon as the route frees.
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
  private packet(data: object) { return encoder.encode(JSON.stringify({ v: 1, room: this.room, ...data })) }
  private send(peer: string, data: object) { this.sendBytes(peer, this.packet(data)) }
  private sendBytes(peer: string, payload: Uint8Array) {
    if (!this.stopped) void this.endpoint.sendDatagram({ dst: peer, srcPort: MEETING_PORT, dstPort: MEETING_PORT, payload }).catch(() => {})
  }
  private receive(peer: string, payload: Uint8Array) {
    const state = this.peers.get(peer)
    if (!state || this.stopped) return
    if (payload[0] === 73) {
      const frame = state.receiver.receive(this.room, payload)
      if (frame) {
        this.heard(peer, state)
        if (frame.kind === 2) { state.receivedFrames++; state.receivedBytes += frame.bytes.length }
        this.callbacks.media?.(peer, frame)
      }
      return
    }
    if (payload.length > 1200) return
    try {
      const p = JSON.parse(decoder.decode(payload))
      if (p.v !== 1 || p.room !== this.room) return
      switch (p.type) {
        case 'hello':
        case 'state':
          if (!p.state || ['audioEnabled', 'videoEnabled', 'screenSharing'].some(k => typeof p.state[k] !== 'boolean')) return
          state.remoteVideo = p.state.videoEnabled || p.state.screenSharing
          this.heard(peer, state)
          this.callbacks.state?.(peer, p.state)
          if (p.type === 'hello') {
            this.send(peer, { type: 'state', state: this.state })
            this.callbacks.heartbeat?.(peer)
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
        case 'keyframe': this.callbacks.keyframe?.(); break
        case 'feedback':
          if (this.sendingVideo() && state.videoSending) {
            state.adaptation.feedback(p)
            this.updateBitrate()
          }
          break
        case 'leave': this.removePeer(peer); this.callbacks.leave?.(peer); break
      }
    } catch { /* Malformed datagrams are not meeting messages. */ }
  }
  private heard(peer: string, state: Peer) {
    state.heard = Date.now()
    state.failed = false
    if (!state.connected) {
      state.connected = true
      state.adaptation.begin()
      this.updateBitrate()
      this.callbacks.connected?.(peer)
    }
  }
  private sendingVideo() { return this.state.videoEnabled || this.state.screenSharing }
  private updateBitrate() {
    // Encode once for the group at the rate supported by every connected receiver.
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
    let helloPayload: Uint8Array | undefined
    for (const [peer, state] of this.peers) {
      const interval = Math.round(perfNow - state.feedbackAt)
      if (interval >= 200) {
        if (state.connected && (state.remoteVideo || state.receivedFrames > 0) && interval <= 5000) {
          this.send(peer, {
            type: 'feedback', feedback_seq: state.feedbackSequence++ >>> 0,
            video_seq: state.receiver.highestVideo, received_frames: state.receivedFrames,
            received_bytes: state.receivedBytes, interval_ms: interval,
          })
        }
        state.feedbackAt = perfNow; state.receivedFrames = 0; state.receivedBytes = 0
      }
      if (this.sendingVideo() && state.videoSending && state.connected) state.adaptation.tick(perfNow)
      if (!state.connected || this.tickCount % 5 === 0) {
        this.sendBytes(peer, helloPayload ??= this.packet({ type: 'hello', state: this.state }))
      }
      if (!state.failed && wallNow - state.heard > 15000) {
        state.connected = false
        state.failed = true
        this.callbacks.failed?.(peer)
      }
    }
    this.updateBitrate()
  }
  async close() {
    if (this.stopped) return
    const leaving = this.sendLeave()
    this.stopped = true
    clearInterval(this.timer); this.unregister(); this.pending.clear(); this.peers.clear()
    if (!leaving.length) return
    let deadline: ReturnType<typeof setTimeout> | undefined
    try {
      // Give established routes a chance to deliver leave, without waiting for
      // an unreachable peer's session handshake before the user can exit.
      await Promise.race([Promise.allSettled(leaving), new Promise<void>(resolve => { deadline = setTimeout(resolve, 500) })])
    } finally { clearTimeout(deadline) }
  }
}
