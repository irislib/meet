import { CallOpus } from './callOpus'
import { callAudioWorklet } from './callAudioWorklet'
import type { MediaFrame } from './callProtocol'
import { callEncoding, callVideoFramerate, callVideoSize } from './callQuality'

interface Receiver {
  stream: MediaStream
  opus: CallOpus
  node: AudioWorkletNode
  destination: MediaStreamAudioDestinationNode
  decoder?: VideoDecoder
  canvas: HTMLCanvasElement
  ctx?: CanvasRenderingContext2D | null
  videoTrack?: CanvasCaptureMediaStreamTrack
  audio: Map<number, MediaFrame>
  nextAudio?: number
  audioAt: number
  audioStart: number
  lastAudio?: number
  video: Array<{ frame: MediaFrame; at: number }>
  lastVideo?: number
  needKey: boolean
  requestedKey: number
  stats: { peer: string; audio: number; video: number; energy: number }
}

function stopWorklet(node?: AudioWorkletNode) {
  if (!node) return
  node.port.onmessage = null
  node.port.postMessage({ stop: true })
  node.port.close()
  node.disconnect()
}

/** One capture/encode pipeline, with independent decoder and jitter state per participant.
 * Uses the same Opus, H.264 and fragmented frame format as Iris Chat.
 */
export class MeetingMedia {
  private context: AudioContext
  private receivers = new Map<string, Receiver>()
  private opening = new Map<string, Promise<void>>()
  private source?: MediaStreamAudioSourceNode
  private captureAudio?: AudioWorkletNode
  private encoderOpus?: CallOpus
  private audioTrack?: MediaStreamTrack
  private videoTrack?: MediaStreamTrack
  private encoder?: VideoEncoder
  private capture = document.createElement('video')
  private canvas = document.createElement('canvas')
  private captureCtx?: CanvasRenderingContext2D | null
  private videoTimer?: ReturnType<typeof setTimeout>
  private stopped = false
  private revision = 0
  private videoRevision = 0
  private epoch = performance.now()
  private audioSeq = 0
  private videoSeq = 0
  private videoWidth = 1280
  private videoHeight = 720
  private frameIntervalMs = 1000 / 30
  private nextCaptureAt = 0
  private lastKey = -Infinity
  private forceKey = true
  private audioEnabled = false
  private videoEnabled = false
  private targetBitrate = 1_200_000
  private constructor(
    context: AudioContext,
    private send: (frame: MediaFrame, allowed: () => boolean) => Promise<void>,
    private remoteStream: (peer: string, stream: MediaStream) => void,
    private requestKey: (peer: string) => void,
    private error: (message: string) => void,
  ) {
    this.context = context
    this.capture.muted = true; this.capture.playsInline = true
    this.capture.onloadeddata = () => this.scheduleVideo()
    window.addEventListener('pointerdown', this.resume)
    window.addEventListener('keydown', this.resume)
  }
  private resume = () => { if (!this.stopped) void this.context.resume().catch(() => {}) }
  static async open(
    send: (frame: MediaFrame, allowed: () => boolean) => Promise<void>,
    remoteStream: (peer: string, stream: MediaStream) => void,
    requestKey: (peer: string) => void,
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
      audio: new Map(), audioAt: 0, audioStart: 0, video: [], needKey: true, requestedKey: -Infinity,
      stats: { peer, audio: 0, video: 0, energy: 0 },
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
    this.audioEnabled = audio; this.videoEnabled = video
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
        // The capture worklet outputs silence; connecting it keeps the audio clock running.
        node.connect(this.context.destination)
        this.source = source; this.captureAudio = node
        node.port.onmessage = event => {
          if (event.data.playout !== undefined) { node.port.postMessage({ played: true }); return }
          node.port.postMessage({ captured: true })
          if (this.stopped || node !== this.captureAudio || !this.audioEnabled) return
          const age = Math.max(0, this.context.currentTime - event.data.capturedAt)
          if (age > .1) return
          const bytes = this.encoderOpus!.encode(event.data.pcm)
          void this.send({ kind: 1, key: true, seq: this.audioSeq++ >>> 0, timestamp: Math.max(0, Math.round((performance.now() - this.epoch - age * 1000) * 1000)), bytes },
            () => !this.stopped && this.audioEnabled && this.captureAudio === node).catch(() => {})
        }
      }
    }
    this.captureAudio?.port.postMessage({ active: audio })
    const videoTrack = (screen ?? stream)?.getVideoTracks()[0]
    if (videoTrack !== this.videoTrack) {
      this.videoRevision++
      if (this.encoder && this.encoder.state !== 'closed') this.encoder.close()
      this.encoder = undefined; this.videoTrack = videoTrack
      this.capture.srcObject = videoTrack ? new MediaStream([videoTrack]) : null
      this.forceKey = true
      if (videoTrack) {
        if (!globalThis.VideoEncoder || !globalThis.VideoDecoder) throw new Error('Video unavailable. Update your browser and try again.')
        const config = this.videoConfig()
        if (!(await VideoEncoder.isConfigSupported(config)).supported) throw new Error('Video unavailable in this browser.')
        if (this.stopped || revision !== this.revision) return
        const version = this.videoRevision
        const allowed = () => !this.stopped && version === this.videoRevision && this.videoEnabled
        this.encoder = new VideoEncoder({
          output: chunk => {
            const seq = this.videoSeq++ >>> 0
            if (!allowed() || chunk.byteLength > 262144) { this.forceKey = true; return }
            const bytes = new Uint8Array(chunk.byteLength); chunk.copyTo(bytes)
            // Transport bounds each peer independently, so a slow participant
            // cannot stall encoding for everyone else.
            void this.send({ kind: 2, key: chunk.type === 'key', seq, timestamp: chunk.timestamp, bytes }, allowed)
              .catch(() => { this.forceKey = true })
          },
          error: () => { if (allowed()) this.error('Video stopped. Turn your camera off and on to retry.') },
        })
        this.configureVideo()
        await this.capture.play().catch(() => {})
      }
    }
    if (video) {
      this.forceKey = true
      this.nextCaptureAt = 0
    }
    this.scheduleVideo()
    this.resume()
  }
  requestKeyframe() { this.forceKey = true }
  setVideoBitrate(bitsPerSecond: number) {
    if (this.stopped || bitsPerSecond === this.targetBitrate) return
    this.targetBitrate = bitsPerSecond
    if (this.encoder?.state === 'configured') this.configureVideo()
  }
  private videoConfig(): VideoEncoderConfig {
    const framerate = callVideoFramerate({}, this.targetBitrate)
    return {
      codec: callEncoding({}).codec,
      ...callVideoSize({}, this.videoTrack?.getSettings(), this.targetBitrate),
      bitrate: this.targetBitrate, framerate,
      latencyMode: 'realtime', bitrateMode: 'constant', avc: { format: 'annexb' },
    }
  }
  private configureVideo() {
    const config = this.videoConfig()
    this.videoWidth = config.width
    this.videoHeight = config.height
    this.frameIntervalMs = 1000 / (config.framerate ?? 30)
    this.canvas.width = config.width; this.canvas.height = config.height
    this.encoder!.configure(config)
    this.forceKey = true
    if (import.meta.env.DEV) (window as any).__DEBUG_MEETING_VIDEO = {
      bitrate: config.bitrate, width: config.width, height: config.height, framerate: config.framerate,
    }
  }
  // Wake only when capturing local video or waiting on an out-of-order remote frame gap.
  private scheduleVideo() {
    if (this.videoTimer !== undefined) { clearTimeout(this.videoTimer); this.videoTimer = undefined }
    if (this.stopped) return
    const now = performance.now()
    let delay = Infinity
    if (this.videoEnabled && this.encoder?.state === 'configured') {
      delay = this.capture.readyState < 2 ? 15 : Math.max(0, this.nextCaptureAt - now)
    }
    for (const r of this.receivers.values()) {
      if (r.video.length) delay = Math.min(delay, Math.max(1, 200 - (now - r.video[0].at)))
    }
    if (delay < Infinity) {
      this.videoTimer = setTimeout(() => {
        this.videoTimer = undefined
        this.captureVideo()
        for (const [peer, r] of this.receivers) if (r.video.length) this.playVideoFor(peer, r)
        this.scheduleVideo()
      }, Math.ceil(delay))
    }
  }
  private captureVideo() {
    if (this.stopped || !this.videoEnabled || this.capture.readyState < 2) return
    if (!this.encoder || this.encoder.state !== 'configured' || this.encoder.encodeQueueSize > 1) return
    const now = performance.now()
    if (this.nextCaptureAt && now + 1 < this.nextCaptureAt) return
    this.nextCaptureAt = this.nextCaptureAt && now - this.nextCaptureAt < this.frameIntervalMs
      ? this.nextCaptureAt + this.frameIntervalMs
      : now + this.frameIntervalMs
    const timestamp = Math.round((now - this.epoch) * 1000)
    let frame: VideoFrame
    if (this.capture.videoWidth === this.videoWidth && this.capture.videoHeight === this.videoHeight) {
      frame = new VideoFrame(this.capture, { timestamp })
    } else {
      const ctx = this.captureCtx ??= this.canvas.getContext('2d')
      ctx!.drawImage(this.capture, 0, 0, this.videoWidth, this.videoHeight)
      frame = new VideoFrame(this.canvas, { timestamp })
    }
    const keyFrame = this.forceKey || now - this.lastKey >= 1000
    if (keyFrame) { this.forceKey = false; this.lastKey = now }
    this.encoder.encode(frame, { keyFrame }); frame.close()
  }
  receive(peer: string, frame: MediaFrame) {
    const r = this.receivers.get(peer)
    if (!r || this.stopped) return
    const now = performance.now()
    if (frame.kind === 1) {
      const delta = r.lastAudio === undefined ? 1 : (frame.seq - r.lastAudio) >>> 0
      if (r.nextAudio === undefined || now - r.audioAt > 200) {
        if (!delta || delta >= 0x80000000) return
        r.audio.clear(); r.nextAudio = frame.seq; r.audioStart = now + 40
      } else if (((frame.seq - r.nextAudio) >>> 0) >= 0x80000000) return
      if (delta < 0x80000000) r.lastAudio = frame.seq
      r.audio.set(frame.seq, frame); r.audioAt = now
      if (r.audio.size > 16) { r.audio.clear(); r.nextAudio = frame.seq; r.audio.set(frame.seq, frame) }
    } else {
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
  private maybeRequestKey(peer: string, r: Receiver, now: number) {
    if (now - r.requestedKey >= 1000) { r.requestedKey = now; this.requestKey(peer) }
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
        this.maybeRequestKey(peer, r, now)
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
              if (import.meta.env.DEV) r.stats.video++
            } finally { decoded.close() }
          },
          error: () => { r.needKey = true; this.requestKey(peer) },
        })
        r.decoder.configure({ codec: 'avc1.42e01f', optimizeForLatency: true })
      }
      if (r.decoder.decodeQueueSize > 3) {
        if (frame.key) {
          r.decoder.reset()
          r.decoder.configure({ codec: 'avc1.42e01f', optimizeForLatency: true })
        } else {
          r.needKey = true
          this.maybeRequestKey(peer, r, now)
          continue
        }
      }
      if (frame.key) r.needKey = false
      try { r.decoder.decode(new EncodedVideoChunk({ type: frame.key ? 'key' : 'delta', timestamp: frame.timestamp, data: frame.bytes })) }
      catch { r.needKey = true; this.maybeRequestKey(peer, r, now) }
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
    this.stopped = true; this.revision++; this.videoRevision++
    if (this.videoTimer !== undefined) { clearTimeout(this.videoTimer); this.videoTimer = undefined }
    this.capture.onloadeddata = null
    window.removeEventListener('pointerdown', this.resume); window.removeEventListener('keydown', this.resume)
    for (const peer of this.receivers.keys()) this.removePeer(peer)
    this.source?.disconnect(); stopWorklet(this.captureAudio); this.encoderOpus?.close()
    if (this.encoder && this.encoder.state !== 'closed') this.encoder.close()
    this.capture.pause(); this.capture.srcObject = null
    void this.context.close().catch(() => {})
  }
}
