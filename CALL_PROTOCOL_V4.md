# Iris Call Protocol v4 (`IC04`)

Shared scalable P2P / blind-SFU media protocol over authenticated unreliable FIPS datagrams (port `39512` for group rooms; interoperable codec baseline: 48 kHz mono Opus + Annex B H.264).

Designed to be implemented identically across `iris-meet`, `iris-chat` (web), and `iris-chat-rs` (Rust core + iOS/Android/macOS/Linux/Windows) while leaving existing 1:1 `IC03` calls on port `39511` untouched.

## 1. Binary Datagram Header (`IC04`, 36 bytes, big-endian)

```text
Offset  Size  Field
0       4     magic: "IC04" (0x49, 0x43, 0x30, 0x34)
4       8     roomTag: SHA-256("iris-call-v4-room:" || roomId)[0..8]
12      4     senderTag: first 4 bytes of sender's ephemeral FIPS x-only pubkey (u32 BE)
16      1     trackId:
                1 = audio (Opus 48 kHz mono; DTX stubs <= 2B suppressed on send)
                2 = video_low  (<= 480x270, <= 15 fps, 90-260 kbps)
                3 = video_high (<= 1280x720, <= 30 fps, 350-2000 kbps)
                4 = screen     (independent screen-share track, <= 1280x720, 10-15 fps)
17      1     flags:
                bit 0 (0x01) = KEYFRAME (IDR)
                bit 1 (0x02) = DISCARDABLE (temporal SVC enhancement frame; safe to drop on congestion)
                bit 2 (0x04) = ENCRYPTED (ChaCha20-Poly1305 SFrame payload)
                (No cleartext speaking/VAD bit: avoids talk-timing leakage to forwarders.)
18      2     keyEpoch (u16 BE; incremented and re-distributed on member removal/leave)
20      4     seq (u32 BE; monotonic per (senderTag, trackId))
24      8     timestampUs (u64 BE; capture timestamp in microseconds)
32      2     fragIndex (u16 BE)
34      2     fragCount (u16 BE)
36..    <=1100 payload chunk
```

## 2. SFrame-Style E2EE & Origin Authentication

- **Per-epoch sender keys (independent of URL/invite secret):** Each sender generates a fresh random 32-byte `senderSecret` per epoch and derives `mediaKey = HKDF-SHA256(senderSecret, salt=roomTag, info="iris-call-v4-media-key", len=32)`.
- **Pairwise key wrapping:** `senderSecret` is wrapped per admitted peer using `shared = fips_ecdh(myEphemeralSecret, peerCompressedPubkey)` -> `wrapKey = HKDF-SHA256(shared, roomTag, "iris-call-v4-key-wrap", 32)` -> `ChaCha20-Poly1305(wrapKey, counter=epoch, plaintext=senderSecret, aad=roomTag || u16be(epoch))`.
- **Revocation:** On participant leave/removal, remaining senders increment `keyEpoch`, generate a new random `senderSecret`, wrap it only for remaining admitted peers, and force keyframes. Removed peers (even if still holding the room link or intercepting forwarder packets) cannot decrypt future frames.
- **Frame encryption:** Entire encoded frame is encrypted once before fragmentation using `ChaCha20-Poly1305(mediaKey, counter=(trackId<<56)|(keyEpoch<<40)|seq, plaintext, aad=header[0..32])`.
- **Anti-impersonation for peer forwarders (closing RFC 9605 §6):** Every ~300 ms or on keyframes, each sender signs a loss-tolerant batch of `(trackId, keyEpoch, seq, SHA256(aad || ciphertext)[0..16])` with its ephemeral FIPS key (`BIP-340 Schnorr`). Even a key-holding peer acting as a forwarder cannot forge another participant's frames without detection and automatic failover.

## 3. Receiver-Driven Subscriptions & Blind Forwarding

- **Viewport subscriptions (`sub` / `fwd_sub`):** Viewers subscribe per sender to `{ audio, video: none|low|high, screen }` bounded by local decoder capacity (`4` mobile, `9` desktop). Small rooms (`<= 4` total) default to `high`; larger grids (`>= 5`) default to `low` thumbnails unless focused (`high`).
- **Demand propagation to camera:** Senders close unused `VideoEncoder` instances immediately when no subscriber or forwarder wants a layer (`video_high`, `video_low`, or `screen`), and emit an immediate IDR keyframe when demand resumes.
- **Receiver-side layer isolation (`ReceiverLayerGuard`):** A single congested viewer downgrades only its own subscription from `high -> low` without affecting healthy viewers' `high` stream, probing back to `high` after sustained healthy delivery.
- **Unified blind forwarder (`CallForwarder` / `BlindForwarderService`):** Holds zero media keys and performs zero decryption/transcoding. Forwards raw `IC04` datagrams directly from bytes `[0..36]`, aggregates union upstream demand (`fwd_demand`), coalesces keyframe storms (500 ms cooldown), serves local hop-by-hop `nack_v4` from a bounded 250 ms ring buffer (max 2 MiB), prioritizes audio unconditionally, and applies bounded per-subscriber AQM (dropping `DISCARDABLE` frames first under congestion).
- **Route-aware topology (`CallTopology`):** Keeps 1-hop mesh for `<= 4` peers; upgrades to `assisted` depth-2 forwarding for `>= 5` peers or when a dedicated blind forwarder (`?sfu=<peer>`) is present. Excludes mobile, background tabs, and FIPS-seed-relayed peers from participant helper election, and uses Rendezvous (HRW) hashing for deterministic track sharding and warm-standby failover.
