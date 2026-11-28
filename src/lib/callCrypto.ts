import {
  aeadOpen,
  aeadSeal,
  ecdh,
  fromHex,
  hkdfDerive,
  signSchnorr,
  toHex,
  verifySchnorr,
  type FipsIdentity,
} from '@fips/core'
import { sha256 } from '@noble/hashes/sha2.js'
import { buildCallV4Aad, type CallV4Header, type TrackId } from './callProtocolV4'

const encoder = new TextEncoder()
const MEDIA_KEY_INFO = encoder.encode('iris-call-v4-media-key')
const KEY_WRAP_INFO = encoder.encode('iris-call-v4-key-wrap')

function mediaCounter(trackId: TrackId, keyEpoch: number, seq: number): bigint {
  return (BigInt(trackId & 0xff) << 56n) | (BigInt(keyEpoch & 0xffff) << 40n) | BigInt(seq >>> 0)
}

export function deriveMediaKey(senderSecret: Uint8Array, roomTag: Uint8Array): Uint8Array {
  return hkdfDerive(senderSecret, roomTag, MEDIA_KEY_INFO, 32)
}

/** Seal an encoded media frame with ChaCha20-Poly1305 binding the full IC04 routing header as AAD. */
export function sealCallV4Frame(mediaKey: Uint8Array, header: CallV4Header, plaintext: Uint8Array): Uint8Array {
  const aad = buildCallV4Aad(header)
  return aeadSeal(mediaKey, mediaCounter(header.trackId, header.keyEpoch, header.seq), plaintext, aad)
}

/** Decrypt and authenticate a sealed IC04 frame. Returns null on tampering, wrong key, or wrong header. */
export function openCallV4Frame(mediaKey: Uint8Array, header: CallV4Header, ciphertext: Uint8Array): Uint8Array | null {
  if (ciphertext.length <= 16) return null
  const aad = buildCallV4Aad(header)
  try {
    return aeadOpen(mediaKey, mediaCounter(header.trackId, header.keyEpoch, header.seq), ciphertext, aad)
  } catch {
    return null
  }
}

function wrapAad(roomTag: Uint8Array, epoch: number): Uint8Array {
  const aad = new Uint8Array(10)
  aad.set(roomTag, 0)
  aad[8] = (epoch >>> 8) & 0xff
  aad[9] = epoch & 0xff
  return aad
}

/** Pairwise ECDH wrap of a fresh per-epoch sender secret for one admitted peer (returns hex). */
export function wrapSenderKey(
  localSecretKey: Uint8Array,
  recipientCompressedPeerHex: string,
  roomTag: Uint8Array,
  epoch: number,
  senderSecret: Uint8Array,
): string {
  const shared = ecdh(localSecretKey, fromHex(recipientCompressedPeerHex))
  const wrapKey = hkdfDerive(shared, roomTag, KEY_WRAP_INFO, 32)
  const sealed = aeadSeal(wrapKey, BigInt(epoch & 0xffff), senderSecret, wrapAad(roomTag, epoch))
  return toHex(sealed)
}

/** Unwrap a pairwise ECDH-wrapped sender secret from an authenticated peer. */
export function unwrapSenderKey(
  localSecretKey: Uint8Array,
  senderCompressedPeerHex: string,
  roomTag: Uint8Array,
  epoch: number,
  wrappedHex: string,
): Uint8Array | null {
  try {
    const sealed = fromHex(wrappedHex)
    if (sealed.length !== 48) return null // 32B secret + 16B Poly1305 tag
    const shared = ecdh(localSecretKey, fromHex(senderCompressedPeerHex))
    const wrapKey = hkdfDerive(shared, roomTag, KEY_WRAP_INFO, 32)
    return aeadOpen(wrapKey, BigInt(epoch & 0xffff), sealed, wrapAad(roomTag, epoch))
  } catch {
    return null
  }
}

interface RemoteEpochEntry {
  epoch: number
  key: Uint8Array
  installedAt: number
}

/**
 * Manages fresh per-epoch sender media keys completely independent of the meeting URL secret.
 * Keeps at most one prior remote epoch briefly so in-flight packets survive rekey transitions.
 */
export class SenderKeyRing {
  private epoch = 0
  private localSecret?: Uint8Array
  private localKey?: Uint8Array
  private remotes = new Map<number, RemoteEpochEntry[]>()

  constructor(private readonly roomTag: Uint8Array) {}

  get currentEpoch(): number {
    return this.epoch
  }

  localMediaKey(): Uint8Array | undefined {
    return this.localKey
  }

  localSenderSecret(): { epoch: number; secret: Uint8Array } | undefined {
    return this.localSecret ? { epoch: this.epoch, secret: this.localSecret } : undefined
  }

  rotateLocalEpoch(): { epoch: number; secret: Uint8Array } {
    this.epoch = (this.epoch + 1) & 0xffff
    if (this.epoch === 0) this.epoch = 1
    const secret = crypto.getRandomValues(new Uint8Array(32))
    this.localSecret = secret
    this.localKey = deriveMediaKey(secret, this.roomTag)
    return { epoch: this.epoch, secret }
  }

  installRemoteKey(senderTag: number, epoch: number, secret: Uint8Array, now = performance.now()) {
    const tag = senderTag >>> 0
    const key = deriveMediaKey(secret, this.roomTag)
    const list = this.remotes.get(tag) ?? []
    const existing = list.findIndex(item => item.epoch === epoch)
    if (existing >= 0) {
      list[existing] = { epoch, key, installedAt: now }
    } else {
      list.push({ epoch, key, installedAt: now })
      list.sort((a, b) => b.epoch - a.epoch)
      while (list.length > 2) list.pop()
    }
    this.remotes.set(tag, list)
  }

  remoteMediaKey(senderTag: number, epoch: number, now = performance.now()): Uint8Array | undefined {
    const list = this.remotes.get(senderTag >>> 0)
    if (!list) return undefined
    // Evict superseded previous epoch after 3s grace window.
    while (list.length > 1 && now - list[0].installedAt > 3000) list.pop()
    return list.find(item => item.epoch === epoch)?.key
  }

  removeSender(senderTag: number) {
    this.remotes.delete(senderTag >>> 0)
  }

  clear() {
    this.localSecret?.fill(0)
    this.localKey?.fill(0)
    this.localSecret = undefined
    this.localKey = undefined
    for (const list of this.remotes.values()) {
      for (const item of list) item.key.fill(0)
    }
    this.remotes.clear()
  }
}

export interface OriginCommitEntry {
  trackId: TrackId
  keyEpoch: number
  seq: number
  hashHex: string // 16-byte SHA-256(AAD || ciphertext) prefix
}

export interface OriginCommitMessage {
  senderTag: number
  entries: OriginCommitEntry[]
  sigHex: string // 64-byte BIP-340 Schnorr signature over canonical digest
}

function frameDigest16Hex(header: CallV4Header, ciphertext: Uint8Array): string {
  const aad = buildCallV4Aad(header)
  const buf = new Uint8Array(aad.length + ciphertext.length)
  buf.set(aad, 0)
  buf.set(ciphertext, aad.length)
  return toHex(sha256(buf).subarray(0, 16))
}

function commitDigest(roomTag: Uint8Array, senderTag: number, entries: OriginCommitEntry[]): Uint8Array {
  const parts: Uint8Array[] = [
    encoder.encode('iris-call-v4-origin-commit:'),
    roomTag,
    encoder.encode(`:${senderTag >>> 0}:`),
  ]
  for (const e of entries) {
    parts.push(encoder.encode(`${e.trackId}:${e.keyEpoch}:${e.seq}:${e.hashHex};`))
  }
  const total = parts.reduce((n, p) => n + p.length, 0)
  const joined = new Uint8Array(total)
  let offset = 0
  for (const p of parts) {
    joined.set(p, offset)
    offset += p.length
  }
  return sha256(joined)
}

/**
 * Loss-tolerant periodic BIP-340 Schnorr origin commitment signer.
 * Prevents even a key-holding peer forwarder from impersonating another participant.
 */
export class OriginCommitSigner {
  private pending: OriginCommitEntry[] = []

  constructor(
    private readonly identity: FipsIdentity,
    private readonly roomTag: Uint8Array,
    private readonly senderTag: number,
  ) {}

  record(header: CallV4Header, ciphertext: Uint8Array) {
    this.pending.push({
      trackId: header.trackId,
      keyEpoch: header.keyEpoch,
      seq: header.seq >>> 0,
      hashHex: frameDigest16Hex(header, ciphertext),
    })
    if (this.pending.length > 64) this.pending.shift()
  }

  get pendingCount(): number {
    return this.pending.length
  }

  flush(): OriginCommitMessage | null {
    if (!this.pending.length) return null
    const entries = this.pending.splice(0, this.pending.length)
    const digest = commitDigest(this.roomTag, this.senderTag, entries)
    const sigHex = toHex(signSchnorr(this.identity, digest))
    return { senderTag: this.senderTag, entries, sigHex }
  }
}

export interface OriginVerifyResult {
  ok: boolean
  verified: number
  forged: number
  invalidSignature?: boolean
}

/** Verifies received SFrame ciphertexts against sender-signed BIP-340 origin commitments. */
export class OriginCommitVerifier {
  private senderKeys = new Map<number, Uint8Array>()
  private observed = new Map<string, string>() // "sender:track:epoch:seq" -> hashHex

  constructor(private readonly roomTag: Uint8Array) {}

  registerSender(senderTag: number, xOnlyPubkey: Uint8Array) {
    this.senderKeys.set(senderTag >>> 0, xOnlyPubkey)
  }

  unregisterSender(senderTag: number) {
    const tag = senderTag >>> 0
    this.senderKeys.delete(tag)
    const prefix = `${tag}:`
    for (const key of this.observed.keys()) if (key.startsWith(prefix)) this.observed.delete(key)
  }

  observeFrame(header: CallV4Header, ciphertext: Uint8Array) {
    const key = `${header.senderTag >>> 0}:${header.trackId}:${header.keyEpoch}:${header.seq >>> 0}`
    this.observed.set(key, frameDigest16Hex(header, ciphertext))
    while (this.observed.size > 512) this.observed.delete(this.observed.keys().next().value!)
  }

  verifyCommit(commit: OriginCommitMessage): OriginVerifyResult {
    const xOnly = this.senderKeys.get(commit.senderTag >>> 0)
    if (!xOnly || !commit.entries.length || commit.entries.length > 64) {
      return { ok: false, verified: 0, forged: 0, invalidSignature: true }
    }
    let sig: Uint8Array
    try {
      sig = fromHex(commit.sigHex)
      if (sig.length !== 64) return { ok: false, verified: 0, forged: 0, invalidSignature: true }
    } catch {
      return { ok: false, verified: 0, forged: 0, invalidSignature: true }
    }
    const digest = commitDigest(this.roomTag, commit.senderTag, commit.entries)
    if (!verifySchnorr(sig, digest, xOnly)) {
      return { ok: false, verified: 0, forged: 0, invalidSignature: true }
    }
    let verified = 0
    let forged = 0
    for (const entry of commit.entries) {
      const key = `${commit.senderTag >>> 0}:${entry.trackId}:${entry.keyEpoch}:${entry.seq >>> 0}`
      const seen = this.observed.get(key)
      if (seen === undefined) continue // Packet dropped in transit; loss-tolerant.
      this.observed.delete(key)
      if (seen === entry.hashHex) verified++
      else forged++
    }
    return { ok: forged === 0, verified, forged }
  }
}
