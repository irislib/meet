# Iris Meet

Simple, private video meetings. No account required.

**Live at [meet.iris.to](https://meet.iris.to)**

## Features

- **No signup** - Join instantly with auto-generated identity
- **End-to-end encrypted** - Signaling encrypted with NIP-44
- **Peer-to-peer** - Direct WebRTC connections, no media server
- **Decentralized** - Signaling over Nostr relays
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
4. **Signal** - Encrypted WebRTC signaling over Nostr (kind 25050)
5. **Connect** - Direct P2P video/audio streams

The meeting secret never leaves the browser. Relay operators see encrypted events authored by the meeting pubkey, but cannot identify participants or decrypt content.

## Development

```bash
pnpm install      # Install dependencies
pnpm run dev      # Dev server at localhost:5173
pnpm run build    # Production build
pnpm run test:e2e # Run Playwright tests
```

## Tech stack

- [Svelte](https://svelte.dev/) + TypeScript
- [Nostr](https://nostr.com/) for decentralized signaling
- [NDK](https://github.com/nostr-dev-kit/ndk) for Nostr connectivity
- [NIP-44](https://github.com/nostr-protocol/nips/blob/master/44.md) encryption
- [WebRTC](https://webrtc.org/) for peer-to-peer media
- [UnoCSS](https://unocss.dev/) for styling
- [Vite](https://vitejs.dev/) for bundling
- [Playwright](https://playwright.dev/) for e2e testing

## License

MIT
