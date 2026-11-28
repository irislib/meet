import { sha256 } from '@noble/hashes/sha2.js'

/**
 * IC04: Multi-track, receiver-subscribed, E2EE-capable media framing over FIPS datagrams.
 *
 * Fixed 36-byte big-endian header:
 *   [0..4]   magic "IC04"
 *   [4..12]  roomTag (8B SHA-256 prefix of room ID)
 *   [12..16] senderTag (u32 from sender's ephemeral FIPS pubkey)
 *   [16]     trackId (1=audio, 2=video_low, 3=video_high, 4=screen)
 *   [17]     flags (bit0=keyframe, bit1=discardable, bit2=encrypted; no speaking/VAD bit)
 *   [18..20] keyEpoch (u16)
 *   [20..24] seq (u32 per sender+trackId)
 *   [24..32] timestampUs (u64)
 *   [32..34] fragIndex (u16)
 *   [34..36] fragCount (u16)
 *   [36..]   chunk payload (<= 1100 bytes)
 */
export const HEADER_V4 = 36
export const CHUNK_V4 = 1100
export const MAX_AUDIO_V4_BYTES = 1320 // 1275 Opus + 16 AEAD tag headroom
export const MAX_VIDEO_V4_BYTES = 262176 // 262144 H.264 + 16 AEAD tag headroom

export const TRACK_AUDIO = 1 as const
export const TRACK_VIDEO_LOW = 2 as const
export const TRACK_VIDEO_HIGH = 3 as const
export const TRACK_SCREEN = 4 as const
export type TrackId = 1 | 2 | 3 | 4

export const FLAG_KEYFRAME = 0x01
export const FLAG_DISCARDABLE = 0x02
export const FLAG_ENCRYPTED = 0x04
const VALID_FLAGS_MASK = FLAG_KEYFRAME | FLAG_DISCARDABLE | FLAG_ENCRYPTED

const U32 = 0x100000000
const FRAME_TTL_MS = 250
const NACK_DELAY_MS = 40
const NACK_RETRY_MS = 50
const MAX_NACK_ATTEMPTS = 2
const encoder = new TextEncoder()

export interface CallV4Header {
  roomTag: Uint8Array
  senderTag: number
  trackId: TrackId
  flags: number
  keyEpoch: number
  seq: number
  timestampUs: number
}

export interface CallV4PacketHeader extends CallV4Header {
  fragIndex: number
  fragCount: number
}

export interface CallV4Frame extends CallV4Header {
  payload: Uint8Array
}

export interface CallV4Nack {
  senderTag: number
  trackId: TrackId
  seq: number
  missing: number[]
}

export function isValidTrackId(trackId: number): trackId is TrackId {
  return trackId === TRACK_AUDIO || trackId === TRACK_VIDEO_LOW || trackId === TRACK_VIDEO_HIGH || trackId === TRACK_SCREEN
}

export function computeRoomTag(roomId: string): Uint8Array {
  return sha256(encoder.encode(`iris-call-v4-room:${roomId}`)).subarray(0, 8)
}

export function senderTagFromPeer(canonicalPeer: string): number {
  const hex = canonicalPeer.length === 66 ? canonicalPeer.slice(2, 10) : canonicalPeer.slice(0, 8)
  return (parseInt(hex, 16) >>> 0)
}

export function roomTagsEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== 8 || b.length !== 8) return false
  for (let i = 0; i < 8; i++) if (a[i] !== b[i]) return false
  return true
}

function writeU32(out: Uint8Array, offset: number, value: number) {
  out[offset] = value >>> 24
  out[offset + 1] = (value >>> 16) & 0xff
  out[offset + 2] = (value >>> 8) & 0xff
  out[offset + 3] = value & 0xff
}

function readU32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
}

/** Build the 32-byte authenticated header prefix used as AEAD AAD. */
export function buildCallV4Aad(header: CallV4Header): Uint8Array {
  const aad = new Uint8Array(32)
  aad[0] = 73; aad[1] = 67; aad[2] = 48; aad[3] = 52 // "IC04"
  aad.set(header.roomTag, 4)
  writeU32(aad, 12, header.senderTag >>> 0)
  aad[16] = header.trackId
  aad[17] = header.flags & VALID_FLAGS_MASK
  aad[18] = (header.keyEpoch >>> 8) & 0xff
  aad[19] = header.keyEpoch & 0xff
  writeU32(aad, 20, header.seq >>> 0)
  writeU32(aad, 24, Math.floor(header.timestampUs / U32))
  writeU32(aad, 28, header.timestampUs >>> 0)
  return aad
}

export function isCallV4Packet(packet: Uint8Array): boolean {
  return packet.length > HEADER_V4 && packet[0] === 73 && packet[1] === 67 && packet[2] === 48 && packet[3] === 52
}

/** Zero-copy blind header inspection for forwarders and demuxers. */
export function peekCallV4Header(packet: Uint8Array): CallV4PacketHeader | null {
  if (packet.length <= HEADER_V4 || packet.length > HEADER_V4 + CHUNK_V4) return null
  if (packet[0] !== 73 || packet[1] !== 67 || packet[2] !== 48 || packet[3] !== 52) return null
  const trackId = packet[16]
  const flags = packet[17]
  if (!isValidTrackId(trackId) || (flags & ~VALID_FLAGS_MASK) !== 0) return null
  const senderTag = readU32(packet, 12)
  const keyEpoch = (packet[18] << 8) | packet[19]
  const seq = readU32(packet, 20)
  const timestampUs = readU32(packet, 24) * U32 + readU32(packet, 28)
  const fragIndex = (packet[32] << 8) | packet[33]
  const fragCount = (packet[34] << 8) | packet[35]
  const max = trackId === TRACK_AUDIO ? MAX_AUDIO_V4_BYTES : MAX_VIDEO_V4_BYTES
  if (
    !Number.isSafeInteger(timestampUs)
    || fragCount === 0
    || fragCount > Math.ceil(max / CHUNK_V4)
    || fragIndex >= fragCount
    || (fragIndex < fragCount - 1 && packet.length !== HEADER_V4 + CHUNK_V4)
  ) {
    return null
  }
  return {
    roomTag: packet.subarray(4, 12),
    senderTag,
    trackId,
    flags,
    keyEpoch,
    seq,
    timestampUs,
    fragIndex,
    fragCount,
  }
}

export function encodeCallV4(frame: CallV4Frame): Uint8Array[] {
  const { roomTag, senderTag, trackId, flags, keyEpoch, seq, timestampUs, payload } = frame
  const max = trackId === TRACK_AUDIO ? MAX_AUDIO_V4_BYTES : MAX_VIDEO_V4_BYTES
  if (
    roomTag.length !== 8
    || !isValidTrackId(trackId)
    || (flags & ~VALID_FLAGS_MASK) !== 0
    || !Number.isInteger(keyEpoch) || keyEpoch < 0 || keyEpoch > 0xffff
    || !Number.isInteger(seq) || seq < 0 || seq > 0xffffffff
    || !Number.isSafeInteger(timestampUs) || timestampUs < 0
    || payload.length === 0 || payload.length > max
  ) {
    return []
  }
  const fragCount = Math.ceil(payload.length / CHUNK_V4)
  const tsHi = Math.floor(timestampUs / U32)
  const tsLo = timestampUs >>> 0
  const packets = new Array<Uint8Array>(fragCount)
  for (let index = 0; index < fragCount; index++) {
    const start = index * CHUNK_V4
    const end = Math.min(payload.length, start + CHUNK_V4)
    const packet = new Uint8Array(HEADER_V4 + (end - start))
    packet[0] = 73; packet[1] = 67; packet[2] = 48; packet[3] = 52
    packet.set(roomTag, 4)
    writeU32(packet, 12, senderTag >>> 0)
    packet[16] = trackId
    packet[17] = flags
    packet[18] = (keyEpoch >>> 8) & 0xff
    packet[19] = keyEpoch & 0xff
    writeU32(packet, 20, seq >>> 0)
    writeU32(packet, 24, tsHi)
    writeU32(packet, 28, tsLo)
    packet[32] = (index >>> 8) & 0xff
    packet[33] = index & 0xff
    packet[34] = (fragCount >>> 8) & 0xff
    packet[35] = fragCount & 0xff
    packet.set(payload.subarray(start, end), HEADER_V4)
    packets[index] = packet
  }
  return packets
}

interface PartialV4 {
  created: number
  nackAt?: number
  attempts: number
  senderTag: number
  trackId: TrackId
  flags: number
  keyEpoch: number
  seq: number
  timestampUs: number
  count: number
  received: number
  bytes: number
  chunks: Array<Uint8Array | undefined>
}

function trackKey(senderTag: number, trackId: TrackId): string {
  return `${senderTag >>> 0}:${trackId}`
}

function frameKey(senderTag: number, trackId: TrackId, seq: number): string {
  return `${senderTag >>> 0}:${trackId}:${seq >>> 0}`
}

/** Bounded multi-sender, multi-track fragment reassembler with local NACK tracking. */
export class CallV4Receiver {
  private partial = new Map<string, PartialV4>()
  private completed = new Map<string, number>()
  private highest = new Map<string, number>()
  private first = new Map<string, number>()
  private lastNow = -Infinity

  constructor(private readonly roomTag: Uint8Array) {}

  highestSeq(senderTag: number, trackId: TrackId): number | undefined {
    return this.highest.get(trackKey(senderTag, trackId))
  }

  firstSeq(senderTag: number, trackId: TrackId): number | undefined {
    return this.first.get(trackKey(senderTag, trackId))
  }

  resetTrack(senderTag: number, trackId: TrackId) {
    const tKey = trackKey(senderTag, trackId)
    this.highest.delete(tKey)
    this.first.delete(tKey)
    const prefix = `${tKey}:`
    for (const key of this.partial.keys()) if (key.startsWith(prefix)) this.partial.delete(key)
  }

  removeSender(senderTag: number) {
    const prefix = `${senderTag >>> 0}:`
    for (const key of this.partial.keys()) if (key.startsWith(prefix)) this.partial.delete(key)
    for (const key of this.completed.keys()) if (key.startsWith(prefix)) this.completed.delete(key)
    for (const key of this.highest.keys()) if (key.startsWith(prefix)) this.highest.delete(key)
    for (const key of this.first.keys()) if (key.startsWith(prefix)) this.first.delete(key)
  }

  private expire(now: number) {
    const monotonic = now >= this.lastNow
    if (monotonic) this.lastNow = now
    for (const [key, frame] of this.partial) {
      if (now - frame.created > FRAME_TTL_MS) this.partial.delete(key)
      else if (monotonic) break
    }
    for (const [key, received] of this.completed) {
      if (now - received > 10000) this.completed.delete(key)
      else if (monotonic) break
    }
  }

  private recordCompleted(key: string, now: number) {
    this.completed.set(key, now)
    while (this.completed.size > 512) this.completed.delete(this.completed.keys().next().value!)
  }

  missingNacks(now = performance.now()): CallV4Nack[] {
    this.expire(now)
    const out: CallV4Nack[] = []
    for (const frame of this.partial.values()) {
      if (frame.trackId === TRACK_AUDIO) continue
      if (frame.attempts >= MAX_NACK_ATTEMPTS) continue
      if (now - frame.created < NACK_DELAY_MS) continue
      if (frame.nackAt !== undefined && now - frame.nackAt < NACK_RETRY_MS) continue
      const missing: number[] = []
      for (let i = 0; i < frame.count && missing.length < 64; i++) {
        if (!frame.chunks[i]) missing.push(i)
      }
      if (!missing.length) continue
      frame.nackAt = now
      frame.attempts++
      out.push({ senderTag: frame.senderTag, trackId: frame.trackId, seq: frame.seq, missing })
      if (out.length >= 4) break
    }
    return out
  }

  receive(packet: Uint8Array, now = performance.now()): CallV4Frame | null {
    this.expire(now)
    const header = peekCallV4Header(packet)
    if (!header || !roomTagsEqual(header.roomTag, this.roomTag)) return null

    const tKey = trackKey(header.senderTag, header.trackId)
    if (!this.first.has(tKey)) this.first.set(tKey, header.seq)
    const prevHigh = this.highest.get(tKey)
    if (prevHigh === undefined || ((header.seq - prevHigh) >>> 0) < 0x80000000) {
      this.highest.set(tKey, header.seq)
    }

    const fKey = frameKey(header.senderTag, header.trackId, header.seq)
    if (this.completed.has(fKey)) return null

    const max = header.trackId === TRACK_AUDIO ? MAX_AUDIO_V4_BYTES : MAX_VIDEO_V4_BYTES
    if (header.fragCount === 1) {
      if (packet.length - HEADER_V4 > max) return null
      this.recordCompleted(fKey, now)
      return {
        roomTag: this.roomTag,
        senderTag: header.senderTag,
        trackId: header.trackId,
        flags: header.flags,
        keyEpoch: header.keyEpoch,
        seq: header.seq,
        timestampUs: header.timestampUs,
        payload: packet.slice(HEADER_V4),
      }
    }

    let partial = this.partial.get(fKey)
    if (!partial) {
      if (this.partial.size >= 48) this.partial.delete(this.partial.keys().next().value!)
      partial = {
        created: now,
        attempts: 0,
        senderTag: header.senderTag,
        trackId: header.trackId,
        flags: header.flags,
        keyEpoch: header.keyEpoch,
        seq: header.seq,
        timestampUs: header.timestampUs,
        count: header.fragCount,
        received: 0,
        bytes: 0,
        chunks: new Array(header.fragCount),
      }
      this.partial.set(fKey, partial)
    }
    if (
      partial.count !== header.fragCount
      || partial.timestampUs !== header.timestampUs
      || partial.flags !== header.flags
      || partial.keyEpoch !== header.keyEpoch
      || partial.chunks[header.fragIndex]
    ) {
      return null
    }
    const chunk = packet.slice(HEADER_V4)
    partial.bytes += chunk.length
    if (partial.bytes > max) {
      this.partial.delete(fKey)
      return null
    }
    partial.chunks[header.fragIndex] = chunk
    if (++partial.received !== partial.count) return null

    const payload = new Uint8Array(partial.bytes)
    let offset = 0
    for (let i = 0; i < partial.count; i++) {
      const part = partial.chunks[i]!
      payload.set(part, offset)
      offset += part.length
    }
    this.partial.delete(fKey)
    this.recordCompleted(fKey, now)
    return {
      roomTag: this.roomTag,
      senderTag: partial.senderTag,
      trackId: partial.trackId,
      flags: partial.flags,
      keyEpoch: partial.keyEpoch,
      seq: partial.seq,
      timestampUs: partial.timestampUs,
      payload,
    }
  }
}
