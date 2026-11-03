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
  private timer: ReturnType<typeof setInterval>
  private stopped = false
  private revision = 0
  private videoRevision = 0
  private epoch = performance.now()
  private audioSeq = 0
  private videoSeq = 0
  private lastCapture = 0
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
    this.timer = setInterval(() => { this.captureVideo(); this.playVideo() }, 10)
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
    this.debugStats()
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
      this.source?.disconnect(); this.captureAudio?.disconnect()
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
    if (video) this.forceKey = true
    this.resume()
  }
  requestKeyframe() { this.forceKey = true }
  setVideoBitrate(bitsPerSecond: number) {
    if (this.stopped || bitsPerSecond === this.targetBitrate) return
    this.targetBitrate = bitsPerSecond
    if (this.encoder?.state === 'configured') this.configureVideo()
  }
  private videoConfig(): VideoEncoderConfig {
    return {
      codec: callEncoding({}).codec,
      ...callVideoSize({}, this.videoTrack?.getSettings(), this.targetBitrate),
      bitrate: this.targetBitrate, framerate: callVideoFramerate({}, this.targetBitrate),
      latencyMode: 'realtime', bitrateMode: 'constant', avc: { format: 'annexb' },
    }
  }
  private configureVideo() {
    const config = this.videoConfig()
    this.canvas.width = config.width; this.canvas.height = config.height
    this.encoder!.configure(config)
    this.forceKey = true
    if (import.meta.env.DEV) (window as any).__DEBUG_MEETING_VIDEO = {
      bitrate: config.bitrate, width: config.width, height: config.height, framerate: config.framerate,
    }
  }
  private captureVideo() {
    if (this.stopped || !this.videoEnabled || this.capture.readyState < 2 || performance.now() - this.lastCapture < 1000 / callVideoFramerate({}, this.targetBitrate)) return
    if (!this.encoder || this.encoder.state !== 'configured' || this.encoder.encodeQueueSize > 1) return
    const now = performance.now()
    this.lastCapture = now
    this.canvas.getContext('2d')!.drawImage(this.capture, 0, 0, this.canvas.width, this.canvas.height)
    const frame = new VideoFrame(this.canvas, { timestamp: Math.round((now - this.epoch) * 1000) })
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
      r.video.push({ frame, at: now }); r.video.sort((a, b) => a.frame.timestamp - b.frame.timestamp)
      if (r.video.length > 8) { r.video.shift(); r.needKey = true }
    }
  }
  private playAudio(r: Receiver) {
    const now = performance.now()
    if (r.nextAudio === undefined || now < r.audioStart || now - r.audioAt > 200) return
    const frame = r.audio.get(r.nextAudio), next = r.audio.get((r.nextAudio + 1) >>> 0)
    const pcm = r.opus.decode(frame?.bytes ?? next?.bytes, !frame && !!next)
    r.audio.delete(r.nextAudio); r.nextAudio = (r.nextAudio + 1) >>> 0
    if (pcm) {
      if (frame) { r.stats.audio++; r.stats.energy += pcm.reduce((sum, sample) => sum + sample * sample, 0) / 48000 }
      r.node.port.postMessage({ pcm }, [pcm.buffer])
      this.debugStats()
    }
  }
  private playVideo() {
    for (const [peer, r] of this.receivers) {
      const now = performance.now()
      while (r.video.length && now - r.video[0].at >= 50) {
        const first = r.video[0]
        const gap = r.lastVideo === undefined ? !first.frame.key : first.frame.seq !== ((r.lastVideo + 1) >>> 0)
        if (gap && now - first.at < 200) break
        const { frame } = r.video.shift()!
        if (gap) r.needKey = true
        r.lastVideo = frame.seq
        if (r.needKey && !frame.key) {
          if (now - r.requestedKey >= 1000) { r.requestedKey = now; this.requestKey(peer) }
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
                r.canvas.getContext('2d')!.drawImage(decoded, 0, 0)
                if (!r.stream.getVideoTracks().length) {
                  const track = r.canvas.captureStream(0).getVideoTracks()[0]
                  r.stream.addTrack(track)
                  this.remoteStream(peer, r.stream)
                }
                ;(r.stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack).requestFrame()
                r.stats.video++; this.debugStats()
              } finally { decoded.close() }
            },
            error: () => { r.needKey = true; this.requestKey(peer) },
          })
          r.decoder.configure({ codec: 'avc1.42e01f', optimizeForLatency: true })
        }
        if (r.decoder.decodeQueueSize > 3) { r.needKey = true; continue }
        if (frame.key) r.needKey = false
        try { r.decoder.decode(new EncodedVideoChunk({ type: frame.key ? 'key' : 'delta', timestamp: frame.timestamp, data: frame.bytes })) }
        catch { r.needKey = true }
      }
    }
  }
  private debugStats() {
    if (import.meta.env.DEV) (window as any).__DEBUG_MEETING_MEDIA = [...this.receivers.values()].map(r => ({ ...r.stats }))
  }
  removePeer(peer: string) {
    this.opening.delete(peer)
    const r = this.receivers.get(peer)
    if (!r) return
    r.node.disconnect(); r.destination.disconnect(); r.opus.close()
    if (r.decoder && r.decoder.state !== 'closed') r.decoder.close()
    r.stream.getTracks().forEach(track => track.stop())
    this.receivers.delete(peer); this.debugStats()
  }
  close() {
    this.stopped = true; this.revision++; this.videoRevision++
    clearInterval(this.timer)
    window.removeEventListener('pointerdown', this.resume); window.removeEventListener('keydown', this.resume)
    for (const peer of this.receivers.keys()) this.removePeer(peer)
    this.source?.disconnect(); this.captureAudio?.disconnect(); this.encoderOpus?.close()
    if (this.encoder && this.encoder.state !== 'closed') this.encoder.close()
    this.capture.pause(); this.capture.srcObject = null
    void this.context.close().catch(() => {})
  }
}
