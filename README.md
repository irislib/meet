# Iris Meet

Simple, private video meetings. No account required.

**Live at [meet.iris.to](https://meet.iris.to)**

Source: <https://git.iris.to/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/meet>

## Features

- **No signup** - Join instantly with auto-generated identity
- **End-to-end encrypted** - Authenticated FIPS sessions for audio, video, and chat
- **Peer-to-peer** - Direct FIPS links with encrypted routing when a direct connection is unavailable
- **Decentralized** - Encrypted room discovery over Nostr relays
- **Private** - Meeting key stays in URL hash, never sent to server

### In-call features

- Video/audio toggle with device selection
- Screen sharing
- Text chat with link parsing
- Click-to-focus any participant
- Connection state indicators
- Keyboard shortcuts (Ctrl+D mute, Ctrl+E camera, ESC unfocus)
- Mobile responsive layout
- PWA with safe area support

## How it works

1. **Create meeting** - Generates a random secret key
2. **Share link** - URL contains the key in the hash (e.g., `meet.iris.to/#<secret>`)
3. **Join** - Participants derive the same room pubkey from the secret
4. **Discover** - `nostr-pubsub` carries NIP-44 encrypted room announcements (kind 25050) over Nostr relays and its FIPS adapter on the same meeting node. Announcements bind each participant to their fresh FIPS session identity. Only admitted room peers exchange events over FIPS
5. **Connect** - FIPS establishes authenticated sessions through WebSocket seeds and upgrades to direct WebRTC data channels when possible
6. **Call** - Opus audio, H.264 video, screen sharing, and chat travel as encrypted FIPS datagrams; WebRTC does not carry native audio/video tracks

The meeting secret stays in the URL fragment and is never published. Nostr relays see encrypted events authored by the meeting pubkey. FIPS routing servers carry encrypted packets and can observe network metadata, but cannot decode call media or chat. Session identities are regenerated on every join.

This uses the same FIPS runtime and media frame format as Iris Chat, with a separate group-meeting service. Existing meeting links still work when participants use the updated app; clients using the old WebRTC meeting protocol cannot join these calls.

Calls require a secure browser context with AudioWorklet support; video and screen sharing also require WebCodecs H.264 encoding and decoding. Audio uses bundled Opus WebAssembly. Media permissions are requested when the user enables their microphone, camera, or screen. Video uses Iris Chat's Automatic quality settings: up to 1280×720 at 30 fps and 2 Mbit/s per recipient. Receiver feedback lowers bitrate, resolution, and frame rate when delivery deteriorates, then gradually raises quality after recovery. One encoder serves the group at a rate supported by every connected receiver; capture is never upscaled.

## Development

```bash
pnpm install      # Install dependencies
pnpm run dev      # Dev server at localhost:5173
pnpm run build    # Production build
pnpm run test     # Unit tests
pnpm run test:e2e # Run Playwright tests
pnpm run release:iris # Build, smoke-test, publish to hashtree, deploy to Cloudflare
```

`VITE_FIPS_SEEDS` overrides the comma-separated WebSocket seed addresses. The defaults are the same public FIPS seeds used by Iris Chat. `VITE_FIPS_STUN_SERVERS` overrides direct-link STUN servers; an empty value gathers only local candidates. `VITE_NOSTR_RELAYS` supplies the initial room discovery relays; connected participants also share announcements through FIPS, so a participant without relay access can discover later arrivals. Meeting announcements expire after 60 seconds and are never persisted or queued for later publication.

Browser tests run against local Nostr and FIPS servers. The FIPS tests cover three-person calls, decoded audio/video, screen sharing, chat, and late joins. They verify that direct calls continue after disconnecting every FIPS routing server, that FIPS routing works when WebRTC is unavailable, and that video quality decreases under packet loss and returns to 720p after recovery. The bundled Opus codec, adaptation logic, and frame protocol were adapted from Iris Chat; its pinned codec build recipe is in `scripts/opus/build.sh`, with the codec license beside the bundled assets.

## Tech stack

- [Svelte](https://svelte.dev/) + TypeScript
- [Nostr](https://nostr.com/) for decentralized signaling
- `nostr-pubsub` for relay connectivity, verified profile caching, and Nostr events over its FIPS adapter
- [NIP-44](https://github.com/nostr-protocol/nips/blob/master/44.md) encryption
- [FIPS](https://github.com/mmalmi/fips-ts) for authenticated peer sessions and routing
- WebCodecs H.264 and bundled libopus for media; WebRTC data channels and WebSockets as FIPS carriers
- [UnoCSS](https://unocss.dev/) for styling
- [Vite](https://vitejs.dev/) for bundling
- [Playwright](https://playwright.dev/) for e2e testing

## License

MIT
