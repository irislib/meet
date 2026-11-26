import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const lockfile = await readFile(new URL('pnpm-lock.yaml', root), 'utf8')

const releases = {
  "@fips/core": {
    "url": "https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.63/fips-core-0.0.58.tgz",
    "integrity": "sha512-UW0PHboZgifo806XxYYjNGgPsKYDMA59YQSvFD0j1k5lhAofX1Yfx+kH38mTYWeTNJQKSr7cMaWqM1Ue2pSV8g=="
  },
  "@fips/transport-webrtc": {
    "url": "https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.63/fips-transport-webrtc-0.0.62.tgz",
    "integrity": "sha512-X4fGxJvosbK62DqW9Zp8mkzMmmH8grVMxKSbtsqgWRCHNIP1nBKQdvmjeYjVG3/KTTVTZXETRQFLSM9ZS2WW7A=="
  },
  "@fips/transport-websocket": {
    "url": "https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.63/fips-transport-websocket-0.0.16.tgz",
    "integrity": "sha512-2KUDBS9/UQ+g+vguCf5hSZBShFGZW9ffXCYXx8jQI9yL9Q8rj8mxd+bnOrv5qAVG8ymbqErI2oVCkyLkpT9cvw=="
  },
  "@iris/svelte-ui": {
    "url": "https://github.com/mmalmi/iris-kit/releases/download/runtime-v0.2.18/iris-svelte-ui-0.1.7.tgz",
    "integrity": "sha512-ucMoZ+SyxpOosGQvAUXuPbhkXhjHjQhPr5qOh85MjdALFITAicYXKT0vN6ZdngINrNQxWjSks42Ek1xcq2ZOUA=="
  },
  "@iris/identity": {
    "url": "https://github.com/mmalmi/iris-kit/releases/download/runtime-v0.2.9/iris-identity-0.4.0.tgz",
    "integrity": "sha512-ZZ7qRjOXl+7fLqsSrWEn9eOysrsbXDsHQz6uxZZw+4wnw3qZXi3xHVdWAia7ykTmFm3euDjNHA+raG33xjacWg=="
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
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.41/hashtree-worker-0.4.25.tgz",
    "integrity": "sha512-viUPl2JUtrfJENEWZPvaTtT5x73Pvj5EmHn7qjsTP5T01uOg0tDm7xJww3cf6x23LILi6drOh97ss0WWYq/KVA=="
  },
  "nostr-pubsub": {
    "url": "https://github.com/mmalmi/nostr-pubsub/releases/download/nostr-pubsub-ts-v0.5.42/nostr-pubsub-0.5.42.tgz",
    "integrity": "sha512-kuEV8FVRU3zPtwTgG95JhztEkPBPV4wQ8Jv+pD6EHF/UfKS/3RpsB/q/+yd6ms9CM/obdbh6xNItOUrSvvBusw=="
  },
  "nostr-social-graph": {
    "url": "https://github.com/mmalmi/nostr-social-graph/releases/download/v4.1.0/nostr-social-graph-4.1.0.tgz",
    "integrity": "sha512-9jHMueBoZOsgsI80XWh4oirJTxoOsvTEs1JvlyIQkrw78ykOi3725fXOmSCKmULyS5vHioitAToOkBru5u1Jcw=="
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
