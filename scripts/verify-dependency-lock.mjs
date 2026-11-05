import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const lockfile = await readFile(new URL('pnpm-lock.yaml', root), 'utf8')

const releases = {
  "@fips/core": {
    "url": "https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.56/fips-core-0.0.52.tgz",
    "integrity": "sha512-omsxRDNQ0iqEBipCD0sOhodDYm0p8cnjt/6BmcDBvtDgQx9F+wL0LXO8hN7MtqZ7KI40wc/gACAudP2+gscXew=="
  },
  "@fips/transport-webrtc": {
    "url": "https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.56/fips-transport-webrtc-0.0.55.tgz",
    "integrity": "sha512-Vgn4xsjfkhvvqKQVTYdBeAVHPb8SYMHlxYH7vP43FSIurnIW0vhpsgXwznodH5QdAiJG7BOI4PoM85Op9gVFBA=="
  },
  "@fips/transport-websocket": {
    "url": "https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.56/fips-transport-websocket-0.0.10.tgz",
    "integrity": "sha512-2KIK6BbfN/OY1nwXkdcPsKmlaLSYfhn8V62RY/zQIbgC8j6QVevlfaxRFYfNjraF+Lz1/M/XNav/a62oABCbTg=="
  },
  "@iris/svelte-ui": {
    "url": "https://github.com/mmalmi/iris-kit/releases/download/runtime-v0.2.6/iris-svelte-ui-0.1.2.tgz",
    "integrity": "sha512-noT2jG+eDoZ+m7GI0+hUvE4obpClkSWdRLomw8zkyaEvcTjnkzGlndw7W0xX49Qv4iMF0ewXkMJcz+NBpdt9yQ=="
  },
  "@iris/identity": {
    "url": "https://github.com/mmalmi/iris-kit/releases/download/runtime-v0.2.6/iris-identity-0.3.1.tgz",
    "integrity": "sha512-HwLi00j/Buf85f//Q4FsKCzvDcidul2U+rNIkfwHZjusNPfJaw6p/Yk4nlKXGkpN4W+TGVj1tZmHGj9Tz8UBAg=="
  },
  "@hashtree/core": {
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.27/hashtree-core-0.4.0.tgz",
    "integrity": "sha512-hdqjU1MoGjc55BL5WM93jgVxW7cYOWCWHcYUl5glUT8boEinFfmlmnhyjGp7TNwWgxZKQ7Rgag9XiyDnRUGBUA=="
  },
  "@hashtree/dexie": {
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.27/hashtree-dexie-0.1.13.tgz",
    "integrity": "sha512-i34YCDwA+d4puwtC2f+4NreOLRC/RRTOe3PDHXctJvaqg2Ig+xpGcb2I1cbjjCY0cVJ8/BTemNYrH0LfXckPwQ=="
  },
  "@hashtree/worker": {
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.33/hashtree-worker-0.4.20.tgz",
    "integrity": "sha512-rFYdFJ1b63HsSDXFffuBVS+INYWLTetsiusGwUjT5NldeOTo1exPmPIKhaUQin95aSw4V0q4XunzierJ7FWcgg=="
  },
  "nostr-pubsub": {
    "url": "https://github.com/mmalmi/nostr-pubsub/releases/download/nostr-pubsub-ts-v0.5.20/nostr-pubsub-0.5.20.tgz",
    "integrity": "sha512-1Cwdk2LR4oCtxiOR1t5+KmdrzDUKrqZfbIZzpXrOR0g+Ex3DCZ33him/qPWU/iYTChPl9eUgi1ZdhL0KdQWZWQ=="
  },
  "nostr-social-graph": {
    "url": "https://github.com/mmalmi/nostr-social-graph/releases/download/v4.0.0/nostr-social-graph-4.0.0.tgz",
    "integrity": "sha512-Y40HbUfRFxvVCArLTkwFJ13NMJAiww3jEwKeVjHar/hCKfZGbptghb/kX9nW0zgT307kiNm7LFrYBTRQEQ78RQ=="
  }
}

for (const [name, release] of Object.entries(releases)) {
  if (manifest.dependencies?.[name] !== release.url) {
    throw new Error(`${name} must use immutable release ${release.url}`)
  }

  const key = `${name}@${release.url}`
  const start = Math.max(lockfile.indexOf(`  '${key}':`), lockfile.indexOf(`  ${key}:`))
  const end = lockfile.indexOf('\n\n', start)
  const entry = start >= 0 ? lockfile.slice(start, end < 0 ? undefined : end) : ''
  if (!entry.includes(`tarball: ${release.url}`) || !entry.includes(`integrity: ${release.integrity}`)) {
    throw new Error(`${name} lock entry is missing its verified release integrity`)
  }
}

for (const [name, specifier] of Object.entries(manifest.dependencies ?? {})) {
  if (/^(?:file|link|workspace):/.test(specifier)) {
    throw new Error(`${name} must not depend on a mutable sibling workspace`)
  }
}
if (/\b(?:file|link):\.\.\//.test(lockfile)) {
  throw new Error('Lockfile must not resolve mutable sibling workspaces')
}

for (const script of ['build', 'check', 'test', 'test:e2e', 'test:offline', 'publish:iris', 'release:iris']) {
  if (!manifest.scripts?.[script]?.startsWith('pnpm run verify:dependency-lock')) {
    throw new Error(`${script} must verify immutable dependency integrity first`)
  }
}

console.log('Verified immutable Meet runtime release integrity')
