# Development

## Commands
```bash
pnpm install      # Install dependencies
pnpm test         # Run tests (placeholder)
pnpm run build    # Build
pnpm run dev      # Dev server
pnpm run test:e2e # E2E tests
```

## Structure
- `src/lib/` - Core libraries (identity, webrtc, meeting, encryption)
- `src/components/` - Svelte UI components
- `e2e/` - Playwright tests

## Design
- **Decentralized**: WebRTC signaling over Nostr relays
- **Encrypted**: NIP-44 encryption for all signaling
- **Anonymous**: Auto-generated keys with animal names

## App Principles
- **Simple**: Google Meet-like UX for video calls
- **Privacy-first**: Meeting key (nsec) in URL hash, never sent to server
- **P2P**: Direct WebRTC connections between participants

## Code Style
- UnoCSS: use utility classes, custom colors in uno.config.ts
- Svelte 5: non-self-closing tags for non-void elements
- Buttons: use `btn-primary`, `btn-secondary`, `btn-danger` shortcuts

## Testing
- TDD is required: write failing test first, then implement
- When tests are failing, increasing timeouts is usually not the solution
- Debug failing/flaky tests with console logs, screenshots, and fix
- Playwright tests in headless mode with fake media devices

### Test Performance
- **NEVER use `waitForTimeout()` for arbitrary delays** - always wait for specific conditions
- Use `expect(locator).toBeVisible()`, `toContainText()`, or `page.waitForURL()` instead
- WebRTC tests use fake media devices via Chrome flags

### Test Parallelism
- Tests run with 100% of CPU cores by default
- When tests fail in parallel but pass with `--workers=1`, check for resource contention
- Multi-user tests may need coordination via Nostr relay timing
- Use `setupPageErrorHandler` to filter noisy relay errors
