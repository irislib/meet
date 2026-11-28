import { describe, expect, it } from 'vitest'
import { generateIdentity, toHex } from '@fips/core'
import {
  CallV4Receiver,
  FLAG_DISCARDABLE,
  FLAG_ENCRYPTED,
  FLAG_KEYFRAME,
  HEADER_V4,
  TRACK_AUDIO,
  TRACK_SCREEN,
  TRACK_VIDEO_HIGH,
  TRACK_VIDEO_LOW,
  computeRoomTag,
  encodeCallV4,
  peekCallV4Header,
  senderTagFromPeer,
} from './callProtocolV4'
import {
  OriginCommitSigner,
  OriginCommitVerifier,
  SenderKeyRing,
  openCallV4Frame,
  sealCallV4Frame,
  unwrapSenderKey,
  wrapSenderKey,
} from './callCrypto'

const room = 'ab'.repeat(16)

describe('IC04 wire framing and blind header inspection', () => {
  it('round-trips multi-track frames and allows zero-copy blind header peeking', () => {
    const roomTag = computeRoomTag(room)
    const senderTag = senderTagFromPeer(`02${'11'.repeat(32)}`)
    const receiver = new CallV4Receiver(roomTag)

    const payload = Uint8Array.from({ length: 3400 }, (_, i) => (i * 13) & 0xff)
    const packets = encodeCallV4({
      roomTag,
      senderTag,
      trackId: TRACK_VIDEO_HIGH,
      flags: FLAG_KEYFRAME | FLAG_ENCRYPTED,
      keyEpoch: 3,
      seq: 77,
      timestampUs: 123456789,
      payload,
    })

    expect(packets).toHaveLength(4)
    expect(packets[0].length).toBe(HEADER_V4 + 1100)

    const peeked = peekCallV4Header(packets[2])
    expect(peeked).toEqual({
      roomTag,
      senderTag,
      trackId: TRACK_VIDEO_HIGH,
      flags: FLAG_KEYFRAME | FLAG_ENCRYPTED,
      keyEpoch: 3,
      seq: 77,
      timestampUs: 123456789,
      fragIndex: 2,
      fragCount: 4,
    })

    // Deliver out of order with duplicates; track independence across layers.
    expect(receiver.receive(packets[3], 10)).toBeNull()
    expect(receiver.receive(packets[0], 11)).toBeNull()
    expect(receiver.receive(packets[2], 12)).toBeNull()
    expect(receiver.receive(packets[2], 13)).toBeNull()
    const assembled = receiver.receive(packets[1], 14)
    expect(assembled).not.toBeNull()
    expect(assembled!.payload).toEqual(payload)
    expect(assembled!.trackId).toBe(TRACK_VIDEO_HIGH)
    expect(assembled!.flags).toBe(FLAG_KEYFRAME | FLAG_ENCRYPTED)
    expect(assembled!.keyEpoch).toBe(3)
    expect(assembled!.seq).toBe(77)

    // Duplicate delivery is rejected.
    expect(receiver.receive(packets[1], 15)).toBeNull()

    // Independent screen and low tracks do not collide on sequence numbers.
    const lowPkts = encodeCallV4({
      roomTag, senderTag, trackId: TRACK_VIDEO_LOW, flags: FLAG_DISCARDABLE,
      keyEpoch: 3, seq: 77, timestampUs: 123456789, payload: new Uint8Array([9, 8, 7]),
    })
    const screenPkts = encodeCallV4({
      roomTag, senderTag, trackId: TRACK_SCREEN, flags: FLAG_KEYFRAME,
      keyEpoch: 3, seq: 77, timestampUs: 123456789, payload: new Uint8Array([4, 5, 6]),
    })
    expect(receiver.receive(lowPkts[0], 20)?.trackId).toBe(TRACK_VIDEO_LOW)
    expect(receiver.receive(screenPkts[0], 21)?.trackId).toBe(TRACK_SCREEN)
    expect(receiver.highestSeq(senderTag, TRACK_VIDEO_HIGH)).toBe(77)
    expect(receiver.highestSeq(senderTag, TRACK_VIDEO_LOW)).toBe(77)
  })

  it('tracks missing video fragments for local NACK recovery and expires stale partials', () => {
    const roomTag = computeRoomTag(room)
    const senderTag = senderTagFromPeer(`02${'22'.repeat(32)}`)
    const receiver = new CallV4Receiver(roomTag)
    const packets = encodeCallV4({
      roomTag, senderTag, trackId: TRACK_VIDEO_HIGH, flags: FLAG_KEYFRAME,
      keyEpoch: 1, seq: 5, timestampUs: 1000, payload: new Uint8Array(3000).fill(7),
    })
    expect(packets).toHaveLength(3)
    receiver.receive(packets[0], 100)
    receiver.receive(packets[2], 105)
    expect(receiver.missingNacks(120)).toEqual([])
    expect(receiver.missingNacks(150)).toEqual([{ senderTag, trackId: TRACK_VIDEO_HIGH, seq: 5, missing: [1] }])
    // Throttled for 50ms.
    expect(receiver.missingNacks(170)).toEqual([])
    // Delivering the missing fragment completes the frame.
    const completed = receiver.receive(packets[1], 180)
    expect(completed?.payload.length).toBe(3000)
    expect(receiver.missingNacks(220)).toEqual([])
  })
})

describe('SFrame-style E2EE, epoch key rotation, and origin anti-impersonation', () => {
  it('encrypts frames end-to-end, binds routing headers as AAD, and locks out removed peers on rekey', async () => {
    const alice = await generateIdentity()
    const bob = await generateIdentity()
    const carol = await generateIdentity()
    const roomTag = computeRoomTag(room)
    const alicePeer = toHex(alice.publicKey)
    const bobPeer = toHex(bob.publicKey)
    const carolPeer = toHex(carol.publicKey)
    const aliceTag = senderTagFromPeer(alicePeer)

    const aliceKeys = new SenderKeyRing(roomTag)
    const bobKeys = new SenderKeyRing(roomTag)
    const carolKeys = new SenderKeyRing(roomTag)

    // Epoch 1: Alice distributes fresh random sender secret to Bob and Carol via pairwise ECDH wrap.
    const epoch1 = aliceKeys.rotateLocalEpoch()
    const forBob1 = wrapSenderKey(alice.secretKey, bobPeer, roomTag, epoch1.epoch, epoch1.secret)
    const forCarol1 = wrapSenderKey(alice.secretKey, carolPeer, roomTag, epoch1.epoch, epoch1.secret)

    bobKeys.installRemoteKey(aliceTag, epoch1.epoch, unwrapSenderKey(bob.secretKey, alicePeer, roomTag, epoch1.epoch, forBob1)!)
    carolKeys.installRemoteKey(aliceTag, epoch1.epoch, unwrapSenderKey(carol.secretKey, alicePeer, roomTag, epoch1.epoch, forCarol1)!)

    const plaintext = new TextEncoder().encode('super-secret-h264-frame-payload')
    const header = {
      roomTag, senderTag: aliceTag, trackId: TRACK_VIDEO_HIGH,
      flags: FLAG_KEYFRAME | FLAG_ENCRYPTED, keyEpoch: epoch1.epoch, seq: 10, timestampUs: 50000,
    }
    const sealed = sealCallV4Frame(aliceKeys.localMediaKey()!, header, plaintext)
    // Ciphertext does not leak plaintext.
    expect(new TextDecoder().decode(sealed)).not.toContain('super-secret')

    // Bob and Carol both decrypt.
    expect(openCallV4Frame(bobKeys.remoteMediaKey(aliceTag, epoch1.epoch)!, header, sealed)).toEqual(plaintext)
    expect(openCallV4Frame(carolKeys.remoteMediaKey(aliceTag, epoch1.epoch)!, header, sealed)).toEqual(plaintext)

    // Tampering with routing metadata (trackId or flags or seq) fails AEAD verification!
    expect(openCallV4Frame(bobKeys.remoteMediaKey(aliceTag, epoch1.epoch)!, { ...header, trackId: TRACK_VIDEO_LOW }, sealed)).toBeNull()
    expect(openCallV4Frame(bobKeys.remoteMediaKey(aliceTag, epoch1.epoch)!, { ...header, seq: 11 }, sealed)).toBeNull()

    // Carol leaves -> Alice rotates to Epoch 2 and distributes ONLY to Bob.
    const epoch2 = aliceKeys.rotateLocalEpoch()
    expect(epoch2.epoch).toBe(2)
    const forBob2 = wrapSenderKey(alice.secretKey, bobPeer, roomTag, epoch2.epoch, epoch2.secret)
    bobKeys.installRemoteKey(aliceTag, epoch2.epoch, unwrapSenderKey(bob.secretKey, alicePeer, roomTag, epoch2.epoch, forBob2)!)

    const header2 = { ...header, keyEpoch: epoch2.epoch, seq: 11 }
    const sealed2 = sealCallV4Frame(aliceKeys.localMediaKey()!, header2, plaintext)
    expect(openCallV4Frame(bobKeys.remoteMediaKey(aliceTag, epoch2.epoch)!, header2, sealed2)).toEqual(plaintext)
    // Carol has no epoch 2 key and cannot decrypt with epoch 1 key!
    expect(carolKeys.remoteMediaKey(aliceTag, epoch2.epoch)).toBeUndefined()
    expect(openCallV4Frame(carolKeys.remoteMediaKey(aliceTag, epoch1.epoch)!, header2, sealed2)).toBeNull()
  })

  it('detects a key-holding peer forwarder attempting to impersonate another participant', async () => {
    const alice = await generateIdentity()
    const bob = await generateIdentity() // malicious peer forwarder who legitimately holds Alice's media key
    const carol = await generateIdentity()
    const roomTag = computeRoomTag(room)
    const alicePeer = toHex(alice.publicKey)
    const aliceTag = senderTagFromPeer(alicePeer)

    const aliceKeys = new SenderKeyRing(roomTag)
    const epoch1 = aliceKeys.rotateLocalEpoch()
    const mediaKey = aliceKeys.localMediaKey()!

    const signer = new OriginCommitSigner(alice, roomTag, aliceTag)
    const verifier = new OriginCommitVerifier(roomTag)
    verifier.registerSender(aliceTag, alice.xOnlyPubkey)

    // Alice sends 3 real frames; frame 2 is lost on the wire to test loss tolerance.
    const h1 = { roomTag, senderTag: aliceTag, trackId: TRACK_AUDIO, flags: FLAG_ENCRYPTED, keyEpoch: 1, seq: 1, timestampUs: 1000 }
    const c1 = sealCallV4Frame(mediaKey, h1, new Uint8Array([1, 2, 3, 4]))
    signer.record(h1, c1)

    const h2 = { roomTag, senderTag: aliceTag, trackId: TRACK_AUDIO, flags: FLAG_ENCRYPTED, keyEpoch: 1, seq: 2, timestampUs: 2000 }
    const c2 = sealCallV4Frame(mediaKey, h2, new Uint8Array([5, 6, 7, 8]))
    signer.record(h2, c2)

    const h3 = { roomTag, senderTag: aliceTag, trackId: TRACK_AUDIO, flags: FLAG_ENCRYPTED, keyEpoch: 1, seq: 3, timestampUs: 3000 }
    const c3 = sealCallV4Frame(mediaKey, h3, new Uint8Array([9, 10, 11, 12]))
    signer.record(h3, c3)

    // Carol receives frame 1 and frame 3 (frame 2 dropped), plus Alice's signed origin commit.
    verifier.observeFrame(h1, c1)
    verifier.observeFrame(h3, c3)
    const commit = signer.flush()!
    expect(verifier.verifyCommit(commit)).toEqual({ ok: true, verified: 2, forged: 0 })

    // Now malicious forwarder Bob uses Alice's symmetric key to forge frame 4 claiming to be Alice!
    const h4 = { roomTag, senderTag: aliceTag, trackId: TRACK_AUDIO, flags: FLAG_ENCRYPTED, keyEpoch: 1, seq: 4, timestampUs: 4000 }
    const real4 = sealCallV4Frame(mediaKey, h4, new Uint8Array([20, 21, 22]))
    const forged4 = sealCallV4Frame(mediaKey, h4, new Uint8Array([99, 99, 99]))
    signer.record(h4, real4) // Alice actually sent real4
    verifier.observeFrame(h4, forged4) // Bob swapped in forged4 to Carol!

    const commit2 = signer.flush()!
    const verdict = verifier.verifyCommit(commit2)
    expect(verdict.ok).toBe(false)
    expect(verdict.forged).toBe(1)

    // Bob also cannot forge an origin commit signed with Bob's key claiming to be Alice!
    const bobFakeSigner = new OriginCommitSigner(bob, roomTag, aliceTag)
    bobFakeSigner.record(h4, forged4)
    const fakeCommit = bobFakeSigner.flush()!
    expect(verifier.verifyCommit(fakeCommit)).toEqual({ ok: false, verified: 0, forged: 0, invalidSignature: true })
    void carol
  })
})
