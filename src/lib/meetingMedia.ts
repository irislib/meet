import { CallOpus, isDtxPacket } from './callOpus'
import { callAudioWorklet } from './callAudioWorklet'
import { LAYER_PROFILES, layerVideoGeometry, type SimulcastLayerName } from './callQuality'
import {
  TRACK_AUDIO,
  TRACK_SCREEN,
  TRACK_VIDEO_HIGH,
  TRACK_VIDEO_LOW,
  type TrackId,
} from './callProtocolV4'
import type { LayerBitrates, MediaDemand, TransportMediaFrame } from './meetingTransport'

interface Receiver {
  stream: MediaStream
  opus: CallOpus
  node: AudioWorkletNode
  destination: MediaStreamAudioDestinationNode
  decoder?: VideoDecoder
  canvas: HTMLCanvasElement
  ctx?: CanvasRenderingContext2D | null
  videoTrack?: CanvasCaptureMediaStreamTrack
  audio: Map<number, TransportMediaFrame>
  nextAudio?: number
  audioAt: number
  audioStart: number
  lastAudio?: number
  audioLost: number
  video: Array<{ frame: TransportMediaFrame; at: number }>
  lastVideo?: number
  activeVideoTrack?: TrackId
  lastScreenAt: number
  needKey: boolean
  requestedKey: number
  stats: { peer: string; audio: number; video: number; energy: number; trackId?: TrackId; width: number; height: number }
}

interface EncoderSlot {
  layer: SimulcastLayerName
  trackId: 2 | 3 | 4
  encoder?: VideoEncoder
  canvas: HTMLCanvasElement
  ctx?: CanvasRenderingContext2D | null
  seq: number
  width: number
  height: number
  framerate: number
  bitrate: number
  nextCaptureAt: number
  lastKey: number
  forceKey: boolean
  encodedFrames: number
  svcL1T2: boolean
  revision: number
}

function stopWorklet(node?: AudioWorkletNode) {
  if (!node) return
  node.port.onmessage = null
  node.port.postMessage({ stop: true })
  node.port.close()
  node.disconnect()
}

function makeSlot(layer: SimulcastLayerName, trackId: 2 | 3 | 4): EncoderSlot {
  const profile = LAYER_PROFILES[layer]
  return {
    layer,
    trackId,
    canvas: document.createElement('canvas'),
    seq: 0,
    width: profile.maxWidth,
    height: profile.maxHeight,
    framerate: profile.maxFramerate,
    bitrate: profile.defaultBitrate,
    nextCaptureAt: 0,
    lastKey: -Infinity,
    forceKey: true,
    encodedFrames: 0,
    svcL1T2: false,
    revision: 0,
  }
}

/**
 * Demand-driven capture/encode pipeline with dual-layer simulcast (low + high),
 * independent screen-share track, Opus DTX silence suppression, and per-peer decoding.
 */
export class MeetingMedia {
  private context: AudioContext
  private receivers = new Map<string, Receiver>()
  private opening = new Map<string, Promise<void>>()
  private source?: MediaStreamAudioSourceNode
  private captureAudio?: AudioWorkletNode
  private encoderOpus?: CallOpus
  private audioTrack?: MediaStreamTrack
  private cameraTrack?: MediaStreamTrack
  private screenTrack?: MediaStreamTrack
  private cameraVideo = document.createElement('video')
  private screenVideo = document.createElement('video')
  private slots: Record<SimulcastLayerName, EncoderSlot> = {
    low: makeSlot('low', TRACK_VIDEO_LOW),
    high: makeSlot('high', TRACK_VIDEO_HIGH),
    screen: makeSlot('screen', TRACK_SCREEN),
  }
  private videoTimer?: ReturnType<typeof setTimeout>
  private stopped = false
  private revision = 0
  private epoch = performance.now()
  private audioSeq = 0
  private audioEnabled = false
  private cameraEnabled = false
  private screenEnabled = false
  private demand: MediaDemand = { audio: true, videoLow: false, videoHigh: true, screen: false }
  private audioSentFrames = 0
  private audioSuppressedDtx = 0
  private audioSentBytes = 0

  private constructor(
    context: AudioContext,
    private send: (frame: TransportMediaFrame, allowed: () => boolean) => Promise<void>,
    private remoteStream: (peer: string, stream: MediaStream) => void,
    private requestKey: (peer: string, trackId?: TrackId) => void,
    private error: (message: string) => void,
  ) {
    this.context = context
    for (const el of [this.cameraVideo, this.screenVideo]) {
      el.muted = true
      el.playsInline = true
      el.onloadeddata = () => this.scheduleVideo()
    }
    window.addEventListener('pointerdown', this.resume)
    window.addEventListener('keydown', this.resume)
  }

  private resume = () => { if (!this.stopped) void this.context.resume().catch(() => {}) }

  static async open(
    send: (frame: TransportMediaFrame, allowed: () => boolean) => Promise<void>,
    remoteStream: (peer: string, stream: MediaStream) => void,
    requestKey: (peer: string, trackId?: TrackId) => void,
    error: (message: string) => void,
  ) {
    if (!globalThis.AudioContext || !globalThis.AudioWorkletNode) throw new Error('Audio unavailable. Use a secure, up-to-date browser.')
    const context = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })
    const url = URL.createObjectURL(new Blob([callAudioWorklet], { type: 'text/javascript' }))
    try {
      await context.audioWorklet.addModule(url)
      void context.resume().catch(() => {})
      return new MeetingMedia(context, send, remoteStream, requestKey, error)
    } catch (error) { await context.close(); throw error }
    finally { URL.revokeObjectURL(url) }
  }

  async addPeer(peer: string) {
    if (this.receivers.has(peer) || this.stopped) return
    if (this.opening.has(peer)) return this.opening.get(peer)
    const pending = this.openPeer(peer, () => this.opening.get(peer) === pending)
    this.opening.set(peer, pending)
    try { await pending } finally { if (this.opening.get(peer) === pending) this.opening.delete(peer) }
  }

  private async openPeer(peer: string, allowed: () => boolean) {
    const opus = await CallOpus.open()
    if (this.stopped || !allowed()) { opus.close(); return }
    const node = new AudioWorkletNode(this.context, 'iris-call-audio', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] })
    const destination = this.context.createMediaStreamDestination()
    node.connect(destination)
    const receiver: Receiver = {
      stream: destination.stream, opus, node, destination, canvas: document.createElement('canvas'),
      audio: new Map(), audioAt: 0, audioStart: 0, audioLost: 0, video: [], lastScreenAt: -Infinity, needKey: true, requestedKey: -Infinity,
      stats: { peer, audio: 0, video: 0, energy: 0, width: 0, height: 0 },
    }
    node.port.onmessage = event => {
      if (event.data.playout === undefined) return
      node.port.postMessage({ played: true })
      if (!this.stopped && this.context.currentTime - event.data.playout < .1) this.playAudio(receiver)
    }
    this.receivers.set(peer, receiver)
    this.remoteStream(peer, receiver.stream)
    this.syncDebugStats()
  }

  async setCapture(stream: MediaStream | null, screen: MediaStream | null, audio: boolean, video: boolean) {
    const revision = ++this.revision
    this.audioEnabled = audio
    const screenTrack = screen?.getVideoTracks()[0]
    const cameraTrack = stream?.getVideoTracks()[0]
    this.screenEnabled = !!screenTrack
    this.cameraEnabled = video && !!cameraTrack

    // Audio capture pipeline
    const audioTrack = stream?.getAudioTracks()[0]
    if (audioTrack !== this.audioTrack) {
      if (audioTrack && !this.encoderOpus) {
        const opus = await CallOpus.open()
        if (this.stopped || revision !== this.revision) { opus.close(); return }
        this.encoderOpus = opus
      }
      if (this.stopped || revision !== this.revision) return
      this.source?.disconnect(); stopWorklet(this.captureAudio)
      this.source = undefined; this.captureAudio = undefined; this.audioTrack = audioTrack
      if (audioTrack) {
        const node = new AudioWorkletNode(this.context, 'iris-call-audio', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
        const source = this.context.createMediaStreamSource(new MediaStream([audioTrack]))
        source.connect(node)
        node.connect(this.context.destination)
        this.source = source; this.captureAudio = node
        node.port.onmessage = event => {
          if (event.data.playout !== undefined) { node.port.postMessage({ played: true }); return }
          node.port.postMessage({ captured: true })
          if (this.stopped || node !== this.captureAudio || !this.audioEnabled) return
          const age = Math.max(0, this.context.currentTime - event.data.capturedAt)
          if (age > .1) return
          const seq = this.audioSeq++ >>> 0
          const bytes = this.encoderOpus!.encode(event.data.pcm)
          // Suppress 1-2 byte Opus DTX silence stubs on the wire (RFC 6716 / libopus).
          if (isDtxPacket(bytes)) {
            this.audioSuppressedDtx++
            this.syncDebugVideo()
            return
          }
          this.audioSentFrames++
          this.audioSentBytes += bytes.byteLength
          this.syncDebugVideo()
          void this.send({
            kind: 1, trackId: TRACK_AUDIO, key: true, seq,
            timestamp: Math.max(0, Math.round((performance.now() - this.epoch - age * 1000) * 1000)),
            bytes,
          }, () => !this.stopped && this.audioEnabled && this.captureAudio === node).catch(() => {})
        }
      }
    }
    this.captureAudio?.port.postMessage({ active: audio })

    // Camera source element (kept independent of screen share)
    if (cameraTrack !== this.cameraTrack) {
      this.cameraTrack = cameraTrack
      this.cameraVideo.srcObject = cameraTrack ? new MediaStream([cameraTrack]) : null
      if (cameraTrack) await this.cameraVideo.play().catch(() => {})
      else this.cameraVideo.pause()
      this.closeSlot(this.slots.low)
      this.closeSlot(this.slots.high)
    }

    // Screen source element (independent track 4)
    if (screenTrack !== this.screenTrack) {
      this.screenTrack = screenTrack
      this.screenVideo.srcObject = screenTrack ? new MediaStream([screenTrack]) : null
      if (screenTrack) await this.screenVideo.play().catch(() => {})
      else this.screenVideo.pause()
      this.closeSlot(this.slots.screen)
    }

    if (this.stopped || revision !== this.revision) return
    await this.reconcileEncoders(revision)
    if (video || this.screenEnabled) {
      for (const slot of Object.values(this.slots)) {
        if (slot.encoder) {
          slot.forceKey = true
          slot.nextCaptureAt = 0
        }
      }
    }
    this.scheduleVideo()
    this.resume()
  }

  /** Updates live subscriber demand; immediately closes unused encoders and starts newly demanded ones. */
  setDemand(demand: MediaDemand) {
    if (this.stopped) return
    const changed = demand.audio !== this.demand.audio
      || demand.videoLow !== this.demand.videoLow
      || demand.videoHigh !== this.demand.videoHigh
      || demand.screen !== this.demand.screen
    if (!changed) return
    this.demand = { ...demand }
    const rev = this.revision
    void this.reconcileEncoders(rev).then(() => {
      if (!this.stopped) this.scheduleVideo()
    }).catch(() => {})
  }

  requestKeyframe(trackId?: TrackId) {
    if (!trackId) {
      this.slots.low.forceKey = true
      this.slots.high.forceKey = true
      this.slots.screen.forceKey = true
      return
    }
    if (trackId === TRACK_VIDEO_LOW) this.slots.low.forceKey = true
    else if (trackId === TRACK_VIDEO_HIGH) this.slots.high.forceKey = true
    else if (trackId === TRACK_SCREEN) this.slots.screen.forceKey = true
  }

  setVideoBitrate(bitsPerSecond: number) {
    if (this.stopped) return
    this.setLayerBitrates({
      low: Math.min(LAYER_PROFILES.low.maxBitrate, bitsPerSecond),
      high: bitsPerSecond,
      screen: bitsPerSecond,
    })
  }

  setLayerBitrates(bitrates: LayerBitrates) {
    if (this.stopped) return
    for (const layer of ['low', 'high', 'screen'] as const) {
      const slot = this.slots[layer]
      const next = bitrates[layer]
      if (next !== slot.bitrate) {
        slot.bitrate = next
        if (slot.encoder?.state === 'configured') this.configureSlot(slot)
      }
    }
    this.syncDebugVideo()
  }

  private slotWanted(layer: SimulcastLayerName): boolean {
    if (layer === 'low') return this.cameraEnabled && !!this.cameraTrack && this.demand.videoLow
    if (layer === 'high') return this.cameraEnabled && !!this.cameraTrack && this.demand.videoHigh
    return this.screenEnabled && !!this.screenTrack && this.demand.screen
  }

  private async reconcileEncoders(expectedRevision: number) {
    for (const layer of ['low', 'high', 'screen'] as const) {
      const slot = this.slots[layer]
      const wanted = this.slotWanted(layer)
      if (!wanted) {
        this.closeSlot(slot)
        continue
      }
      if (!slot.encoder || slot.encoder.state === 'closed') {
        await this.openSlot(slot, expectedRevision)
      }
    }
    this.syncDebugVideo()
  }

  private closeSlot(slot: EncoderSlot) {
    slot.revision++
    if (slot.encoder && slot.encoder.state !== 'closed') {
      try { slot.encoder.close() } catch { /* Already closed. */ }
    }
    slot.encoder = undefined
    slot.forceKey = true
    slot.nextCaptureAt = 0
  }

  private slotConfig(slot: EncoderSlot, withSvc = slot.svcL1T2): VideoEncoderConfig {
    const track = slot.layer === 'screen' ? this.screenTrack : this.cameraTrack
    const geom = layerVideoGeometry(slot.layer, track?.getSettings(), slot.bitrate)
    return {
      codec: LAYER_PROFILES[slot.layer].codec,
      width: geom.width,
      height: geom.height,
      bitrate: geom.bitrate,
      framerate: geom.framerate,
      latencyMode: 'realtime',
      bitrateMode: 'constant',
      avc: { format: 'annexb' },
      ...(withSvc ? { scalabilityMode: 'L1T2' } : {}),
    }
  }

  private async openSlot(slot: EncoderSlot, expectedRevision: number) {
    if (!globalThis.VideoEncoder || !globalThis.VideoDecoder) {
      throw new Error('Video unavailable. Update your browser and try again.')
    }
    // Check optional L1T2 temporal scalability for safe discardable frame marking.
    let useSvc = false
    const svcProbe = this.slotConfig(slot, true)
    try {
      if ((await VideoEncoder.isConfigSupported(svcProbe)).supported) useSvc = true
    } catch { useSvc = false }

    const baseConfig = this.slotConfig(slot, useSvc)
    if (!useSvc && !(await VideoEncoder.isConfigSupported(baseConfig)).supported) {
      throw new Error('Video unavailable in this browser.')
    }
    if (this.stopped || expectedRevision !== this.revision || !this.slotWanted(slot.layer)) return

    slot.svcL1T2 = useSvc
    const version = ++slot.revision
    const allowed = () => !this.stopped && version === slot.revision && this.slotWanted(slot.layer)
    slot.encoder = new VideoEncoder({
      output: (chunk, metadata) => {
        const seq = slot.seq++ >>> 0
        if (!allowed() || chunk.byteLength > 262144) { slot.forceKey = true; return }
        const bytes = new Uint8Array(chunk.byteLength)
        chunk.copyTo(bytes)
        slot.encodedFrames++
        const temporalId = (metadata as { svc?: { temporalLayerId?: number } } | undefined)?.svc?.temporalLayerId ?? 0
        const discardable = slot.svcL1T2 && chunk.type !== 'key' && temporalId > 0
        void this.send({
          kind: 2,
          trackId: slot.trackId,
          key: chunk.type === 'key',
          discardable,
          seq,
          timestamp: chunk.timestamp,
          bytes,
        }, allowed).catch(() => { slot.forceKey = true })
      },
      error: () => { if (allowed()) this.error('Video stopped. Turn your camera off and on to retry.') },
    })
    this.configureSlot(slot)
    slot.nextCaptureAt = 0
  }

  private configureSlot(slot: EncoderSlot) {
    const config = this.slotConfig(slot)
    slot.width = config.width
    slot.height = config.height
    slot.framerate = config.framerate ?? LAYER_PROFILES[slot.layer].maxFramerate
    slot.canvas.width = config.width
    slot.canvas.height = config.height
    slot.encoder!.configure(config)
    slot.forceKey = true
    this.syncDebugVideo()
  }

  private syncDebugVideo() {
    if (!import.meta.env.DEV) return
    const describe = (slot: EncoderSlot) => ({
      active: !!slot.encoder && slot.encoder.state === 'configured',
      bitrate: slot.bitrate,
      width: slot.width,
      height: slot.height,
      framerate: slot.framerate,
      encodedFrames: slot.encodedFrames,
      svcL1T2: slot.svcL1T2,
    })
    const primary = this.slots.screen.encoder ? this.slots.screen
      : this.slots.high.encoder ? this.slots.high
      : this.slots.low
    ;(window as any).__DEBUG_MEETING_VIDEO = {
      bitrate: primary.bitrate,
      width: primary.width,
      height: primary.height,
      framerate: primary.framerate,
      layers: {
        low: describe(this.slots.low),
        high: describe(this.slots.high),
        screen: describe(this.slots.screen),
      },
      audio: {
        sentFrames: this.audioSentFrames,
        suppressedDtx: this.audioSuppressedDtx,
        sentBytes: this.audioSentBytes,
      },
    }
  }

  // Wake only when an active demanded encoder is due or waiting on an out-of-order remote frame gap.
  private scheduleVideo() {
    if (this.videoTimer !== undefined) { clearTimeout(this.videoTimer); this.videoTimer = undefined }
    if (this.stopped) return
    const now = performance.now()
    let delay = Infinity
    for (const slot of Object.values(this.slots)) {
      if (!slot.encoder || slot.encoder.state !== 'configured' || !this.slotWanted(slot.layer)) continue
      const source = slot.layer === 'screen' ? this.screenVideo : this.cameraVideo
      const slotDelay = source.readyState < 2 ? 15 : Math.max(0, slot.nextCaptureAt - now)
      if (slotDelay < delay) delay = slotDelay
    }
    for (const r of this.receivers.values()) {
      if (r.video.length) delay = Math.min(delay, Math.max(1, 200 - (now - r.video[0].at)))
    }
    if (delay < Infinity) {
      this.videoTimer = setTimeout(() => {
        this.videoTimer = undefined
        this.captureDueSlots()
        for (const [peer, r] of this.receivers) if (r.video.length) this.playVideoFor(peer, r)
        this.scheduleVideo()
      }, Math.ceil(delay))
    }
  }

  private captureDueSlots() {
    if (this.stopped) return
    const now = performance.now()
    const timestamp = Math.round((now - this.epoch) * 1000)
    for (const slot of Object.values(this.slots)) {
      if (!slot.encoder || slot.encoder.state !== 'configured' || !this.slotWanted(slot.layer)) continue
      if (slot.encoder.encodeQueueSize > 1) continue
      const source = slot.layer === 'screen' ? this.screenVideo : this.cameraVideo
      if (source.readyState < 2) continue
      if (slot.nextCaptureAt && now + 1 < slot.nextCaptureAt) continue
      const intervalMs = 1000 / Math.max(1, slot.framerate)
      slot.nextCaptureAt = slot.nextCaptureAt && now - slot.nextCaptureAt < intervalMs
        ? slot.nextCaptureAt + intervalMs
        : now + intervalMs
      let frame: VideoFrame
      if (source.videoWidth === slot.width && source.videoHeight === slot.height) {
        frame = new VideoFrame(source, { timestamp })
      } else {
        const ctx = slot.ctx ??= slot.canvas.getContext('2d')
        ctx!.drawImage(source, 0, 0, slot.width, slot.height)
        frame = new VideoFrame(slot.canvas, { timestamp })
      }
      const keyFrame = slot.forceKey || now - slot.lastKey >= 1000
      if (keyFrame) { slot.forceKey = false; slot.lastKey = now }
      slot.encoder.encode(frame, { keyFrame })
      frame.close()
    }
  }

  setPeerScreen(peer: string, screenSharing: boolean) {
    const r = this.receivers.get(peer)
    if (!r) return
    if (!screenSharing) r.lastScreenAt = -Infinity
  }

  receive(peer: string, frame: TransportMediaFrame) {
    const r = this.receivers.get(peer)
    if (!r || this.stopped) return
    const now = performance.now()
    if (frame.kind === 1) {
      const delta = r.lastAudio === undefined ? 1 : (frame.seq - r.lastAudio) >>> 0
      if (r.nextAudio === undefined || now - r.audioAt > 200) {
        if (!delta || delta >= 0x80000000) return
        r.audio.clear(); r.nextAudio = frame.seq; r.audioStart = now + 40; r.audioLost = 0
      } else if (((frame.seq - r.nextAudio) >>> 0) >= 0x80000000) return
      if (delta < 0x80000000) r.lastAudio = frame.seq
      r.audio.set(frame.seq, frame); r.audioAt = now
      if (r.audio.size > 16) { r.audio.clear(); r.nextAudio = frame.seq; r.audio.set(frame.seq, frame) }
    } else {
      const incomingTrack: TrackId = frame.trackId ?? TRACK_VIDEO_HIGH
      if (incomingTrack === TRACK_SCREEN) r.lastScreenAt = now
      // Seamless layer/track switch (low <-> high or camera <-> screen) without recreating the MediaStream.
      if (r.activeVideoTrack !== undefined && r.activeVideoTrack !== incomingTrack) {
        if (r.activeVideoTrack === TRACK_SCREEN && incomingTrack !== TRACK_SCREEN && now - r.lastScreenAt < 400) {
          return
        }
        r.video = []
        r.lastVideo = undefined
        r.needKey = true
        r.activeVideoTrack = incomingTrack
        if (!frame.key) {
          this.maybeRequestKey(peer, r, now, incomingTrack)
          return
        }
      } else if (r.activeVideoTrack === undefined) {
        r.activeVideoTrack = incomingTrack
      }

      if (r.lastVideo !== undefined && ((frame.seq - r.lastVideo) >>> 0) >= 0x80000000) return
      r.video.push({ frame, at: now })
      if (r.video.length > 1) r.video.sort((a, b) => a.frame.timestamp - b.frame.timestamp || ((a.frame.seq - b.frame.seq) | 0))
      if (r.video.length > 8) { r.video.shift(); r.needKey = true }
      this.playVideoFor(peer, r)
      if (r.video.length) this.scheduleVideo()
    }
  }

  private playAudio(r: Receiver) {
    const now = performance.now()
    if (r.nextAudio === undefined || now < r.audioStart || now - r.audioAt > 200) return
    const frame = r.audio.get(r.nextAudio), next = r.audio.get((r.nextAudio + 1) >>> 0)
    if (!frame && !next) {
      r.audioLost++
      // Bound PLC to 100ms (5 frames) so DTX silence gaps stay clean instead of hallucinating audio.
      if (r.audioLost > 5) {
        r.audio.delete(r.nextAudio)
        r.nextAudio = (r.nextAudio + 1) >>> 0
        return
      }
    } else {
      r.audioLost = 0
    }
    const pcm = r.opus.decode(frame?.bytes ?? next?.bytes, !frame && !!next)
    r.audio.delete(r.nextAudio); r.nextAudio = (r.nextAudio + 1) >>> 0
    if (pcm) {
      if (import.meta.env.DEV && frame) {
        r.stats.audio++
        let sum = 0
        for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i]
        r.stats.energy += sum / 48000
      }
      r.node.port.postMessage({ pcm }, [pcm.buffer])
    }
  }

  private maybeRequestKey(peer: string, r: Receiver, now: number, trackId?: TrackId) {
    if (now - r.requestedKey >= 1000) {
      r.requestedKey = now
      this.requestKey(peer, trackId ?? r.activeVideoTrack)
    }
  }

  private playVideoFor(peer: string, r: Receiver) {
    const now = performance.now()
    while (r.video.length) {
      const first = r.video[0]
      const gap = r.lastVideo === undefined ? !first.frame.key : first.frame.seq !== ((r.lastVideo + 1) >>> 0)
      if (gap && now - first.at < 200) break
      const { frame } = r.video.shift()!
      if (gap) r.needKey = true
      r.lastVideo = frame.seq
      if (r.needKey && !frame.key) {
        this.maybeRequestKey(peer, r, now, frame.trackId)
        continue
      }
      if (!globalThis.VideoDecoder) continue
      if (!r.decoder || r.decoder.state === 'closed') {
        r.decoder = new VideoDecoder({
          output: decoded => {
            try {
              if (this.stopped || !this.receivers.has(peer)) return
              if (r.canvas.width !== decoded.displayWidth) r.canvas.width = decoded.displayWidth
              if (r.canvas.height !== decoded.displayHeight) r.canvas.height = decoded.displayHeight
              const ctx = r.ctx ??= r.canvas.getContext('2d')
              ctx!.drawImage(decoded, 0, 0)
              if (!r.videoTrack) {
                r.videoTrack = r.canvas.captureStream(0).getVideoTracks()[0] as CanvasCaptureMediaStreamTrack
                r.stream.addTrack(r.videoTrack)
                this.remoteStream(peer, r.stream)
              }
              r.videoTrack.requestFrame()
              if (import.meta.env.DEV) {
                r.stats.video++
                r.stats.trackId = r.activeVideoTrack
                r.stats.width = decoded.displayWidth
                r.stats.height = decoded.displayHeight
              }
            } finally { decoded.close() }
          },
          error: () => { r.needKey = true; this.requestKey(peer, r.activeVideoTrack) },
        })
        r.decoder.configure({ codec: 'avc1.42e01f', optimizeForLatency: true })
      }
      if (r.decoder.decodeQueueSize > 3) {
        if (frame.key) {
          r.decoder.reset()
          r.decoder.configure({ codec: 'avc1.42e01f', optimizeForLatency: true })
        } else {
          r.needKey = true
          this.maybeRequestKey(peer, r, now, frame.trackId)
          continue
        }
      }
      if (frame.key) r.needKey = false
      try { r.decoder.decode(new EncodedVideoChunk({ type: frame.key ? 'key' : 'delta', timestamp: frame.timestamp, data: frame.bytes })) }
      catch { r.needKey = true; this.maybeRequestKey(peer, r, now, frame.trackId) }
    }
  }

  private syncDebugStats() {
    if (import.meta.env.DEV) (window as any).__DEBUG_MEETING_MEDIA = [...this.receivers.values()].map(r => r.stats)
  }

  removePeer(peer: string) {
    this.opening.delete(peer)
    const r = this.receivers.get(peer)
    if (!r) return
    stopWorklet(r.node); r.destination.disconnect(); r.opus.close()
    if (r.decoder && r.decoder.state !== 'closed') r.decoder.close()
    r.stream.getTracks().forEach(track => track.stop())
    this.receivers.delete(peer); this.syncDebugStats()
  }

  close() {
    this.stopped = true; this.revision++
    if (this.videoTimer !== undefined) { clearTimeout(this.videoTimer); this.videoTimer = undefined }
    this.cameraVideo.onloadeddata = null; this.screenVideo.onloadeddata = null
    window.removeEventListener('pointerdown', this.resume); window.removeEventListener('keydown', this.resume)
    for (const peer of this.receivers.keys()) this.removePeer(peer)
    this.source?.disconnect(); stopWorklet(this.captureAudio); this.encoderOpus?.close()
    for (const slot of Object.values(this.slots)) this.closeSlot(slot)
    this.cameraVideo.pause(); this.cameraVideo.srcObject = null
    this.screenVideo.pause(); this.screenVideo.srcObject = null
    void this.context.close().catch(() => {})
  }
}
