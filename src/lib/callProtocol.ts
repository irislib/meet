/** Compressed media frames travel only in authenticated FIPS datagrams. */
export const MAX_AUDIO_BYTES = 1275
export const MAX_VIDEO_BYTES = 262144
const HEADER = 38
const CHUNK = 1100
const U32 = 0x100000000

export type CallControl = {
  v: 3
  type: 'offer' | 'answer' | 'reject' | 'end' | 'ping' | 'pong' | 'media_state' | 'feedback' | 'keyframe' | 'nack'
  call_id: string
  video?: boolean
  muted?: boolean
  reason?: string
  frame_seq?: number
  missing?: number[]
  feedback_seq?: number
  video_seq?: number
  received_frames?: number
  received_bytes?: number
  interval_ms?: number
}

export const validCallId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id)
const validSequence = (seq: unknown): seq is number => typeof seq === 'number' && Number.isInteger(seq) && seq >= 0 && seq <= 0xffffffff

export interface MediaFrame { kind: 1 | 2; seq: number; timestamp: number; key: boolean; bytes: Uint8Array }

let cachedId = ''
let cachedIdBytes: Uint8Array | undefined

function callIdBytes(id: string): Uint8Array | null {
  if (id === cachedId && cachedIdBytes) return cachedIdBytes
  if (!validCallId(id)) return null
  const out = new Uint8Array(16)
  for (let i = 0; i < 16; i++) out[i] = parseInt(id.slice(i * 2, i * 2 + 2), 16)
  cachedId = id
  cachedIdBytes = out
  return out
}

function writeU32(out: Uint8Array, offset: number, value: number) {
  out[offset] = value >>> 24
  out[offset + 1] = (value >>> 16) & 0xff
  out[offset + 2] = (value >>> 8) & 0xff
  out[offset + 3] = value & 0xff
}

function readU32(bytes: Uint8Array, offset: number) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
}

export function encodeCallMedia(id: string, frame: MediaFrame): Uint8Array[] {
  const { kind, seq, timestamp, key, bytes } = frame
  const idBytes = callIdBytes(id)
  if (!idBytes || !validSequence(seq) || !Number.isSafeInteger(timestamp) || timestamp < 0 || !bytes.length || bytes.length > (kind === 1 ? MAX_AUDIO_BYTES : MAX_VIDEO_BYTES) || (kind !== 1 && kind !== 2)) return []
  const count = Math.ceil(bytes.length / CHUNK)
  const tsHi = Math.floor(timestamp / U32)
  const tsLo = timestamp >>> 0
  const packets = new Array<Uint8Array>(count)
  for (let index = 0; index < count; index++) {
    const start = index * CHUNK
    const end = Math.min(bytes.length, start + CHUNK)
    const packet = new Uint8Array(HEADER + (end - start))
    packet[0] = 73; packet[1] = 67; packet[2] = 48; packet[3] = 51
    packet.set(idBytes, 4)
    packet[20] = kind
    packet[21] = key ? 1 : 0
    writeU32(packet, 22, seq)
    writeU32(packet, 26, tsHi)
    writeU32(packet, 30, tsLo)
    packet[34] = (index >>> 8) & 0xff
    packet[35] = index & 0xff
    packet[36] = (count >>> 8) & 0xff
    packet[37] = count & 0xff
    packet.set(bytes.subarray(start, end), HEADER)
    packets[index] = packet
  }
  return packets
}

interface PartialFrame {
  created: number
  kind: 1 | 2
  seq: number
  timestamp: number
  key: boolean
  count: number
  received: number
  bytes: number
  chunks: Array<Uint8Array | undefined>
}

export class CallMediaReceiver {
  highestVideo?: number
  private partial = new Map<number, PartialFrame>()
  private completed = new Map<number, number>()
  private lastNow = -Infinity
  private roomId = ''
  private roomBytes: Uint8Array | null = null

  private expire(now: number) {
    const monotonic = now >= this.lastNow
    if (monotonic) this.lastNow = now
    for (const [key, frame] of this.partial) {
      if (now - frame.created > 250) this.partial.delete(key)
      else if (monotonic) break
    }
    for (const [key, received] of this.completed) {
      if (now - received > 10000) this.completed.delete(key)
      else if (monotonic) break
    }
  }

  private recordCompleted(key: number, now: number) {
    this.completed.set(key, now)
    while (this.completed.size > 128) this.completed.delete(this.completed.keys().next().value!)
  }

  receive(id: string, packet: Uint8Array, now = performance.now()): MediaFrame | null {
    this.expire(now)
    if (packet.length <= HEADER || packet.length > HEADER + CHUNK || packet[0] !== 73 || packet[1] !== 67 || packet[2] !== 48 || packet[3] !== 51) return null
    if (id !== this.roomId) {
      this.roomId = id
      this.roomBytes = callIdBytes(id)
    }
    const expectedId = this.roomBytes
    if (!expectedId) return null
    for (let i = 0; i < 16; i++) if (packet[4 + i] !== expectedId[i]) return null
    const kind = packet[20]
    if ((kind !== 1 && kind !== 2) || packet[21] > 1) return null
    const seq = readU32(packet, 22)
    const timestamp = readU32(packet, 26) * U32 + readU32(packet, 30)
    const index = (packet[34] << 8) | packet[35]
    const count = (packet[36] << 8) | packet[37]
    const keyFrame = packet[21] === 1
    const max = kind === 1 ? MAX_AUDIO_BYTES : MAX_VIDEO_BYTES
    if (!Number.isSafeInteger(timestamp) || !count || count > Math.ceil(max / CHUNK) || index >= count || (index < count - 1 && packet.length !== HEADER + CHUNK)) return null
    if (kind === 2 && (this.highestVideo === undefined || ((seq - this.highestVideo) >>> 0) < 0x80000000)) this.highestVideo = seq
    const key = kind * U32 + seq
    if (this.completed.has(key)) return null

    // Fast path: single-chunk frames (all audio and small video frames) skip partial map allocation.
    if (count === 1) {
      if (packet.length - HEADER > max) return null
      this.recordCompleted(key, now)
      return { kind, seq, timestamp, key: keyFrame, bytes: packet.slice(HEADER) }
    }

    let frame = this.partial.get(key)
    if (!frame) {
      if (this.partial.size >= 16) this.partial.delete(this.partial.keys().next().value!)
      frame = { created: now, kind, seq, timestamp, key: keyFrame, count, received: 0, bytes: 0, chunks: new Array(count) }
      this.partial.set(key, frame)
    }
    if (frame.count !== count || frame.timestamp !== timestamp || frame.key !== keyFrame || frame.chunks[index]) return null
    const chunk = packet.slice(HEADER)
    frame.bytes += chunk.length
    if (frame.bytes > max) { this.partial.delete(key); return null }
    frame.chunks[index] = chunk
    if (++frame.received !== count) return null
    const bytes = new Uint8Array(frame.bytes)
    let offset = 0
    for (let i = 0; i < count; i++) {
      const part = frame.chunks[i]!
      bytes.set(part, offset)
      offset += part.length
    }
    this.partial.delete(key)
    this.recordCompleted(key, now)
    return { kind: frame.kind, seq: frame.seq, timestamp: frame.timestamp, key: frame.key, bytes }
  }
}
