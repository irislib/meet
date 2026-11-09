import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const lockfile = await readFile(new URL('pnpm-lock.yaml', root), 'utf8')

const releases = {
  "@fips/core": {
    "url": "https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.61/fips-core-0.0.56.tgz",
    "integrity": "sha512-vXfPsXWlXIEZFFl6K+x9YCwOhRPQr4gjw+GfWOfuyI1RW1O1tcdKQBcDbIszByNWVCt/Rs8UOAzv+k+iXNlIOQ=="
  },
  "@fips/transport-webrtc": {
    "url": "https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.61/fips-transport-webrtc-0.0.60.tgz",
    "integrity": "sha512-te9hazkbDXnV4hBYX4pIX594WDY5XVClh9tZCVAm5GzE8bHyoFEAhIpyWiUpbciawaYdRLubkcar3D8A7bViYA=="
  },
  "@fips/transport-websocket": {
    "url": "https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.61/fips-transport-websocket-0.0.14.tgz",
    "integrity": "sha512-B+CUOBXuMwfDzLCnr+QfLf/MuA4wcV+36mqwH+RS0DNRYFcoGgM60MZiwcjFVCb6xzl0ZTUYe9Sla+VJ2MJBnQ=="
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
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.41/hashtree-worker-0.4.25.tgz",
    "integrity": "sha512-viUPl2JUtrfJENEWZPvaTtT5x73Pvj5EmHn7qjsTP5T01uOg0tDm7xJww3cf6x23LILi6drOh97ss0WWYq/KVA=="
  },
  "nostr-pubsub": {
    "url": "https://github.com/mmalmi/nostr-pubsub/releases/download/nostr-pubsub-ts-v0.5.20/nostr-pubsub-0.5.20.tgz",
    "integrity": "sha512-1Cwdk2LR4oCtxiOR1t5+KmdrzDUKrqZfbIZzpXrOR0g+Ex3DCZ33him/qPWU/iYTChPl9eUgi1ZdhL0KdQWZWQ=="
  },
  "nostr-social-graph": {
    "url": "https://github.com/mmalmi/nostr-social-graph/releases/download/v4.0.4/nostr-social-graph-4.0.4.tgz",
    "integrity": "sha512-7lMB0fYsjIBQwn/03lY8+0gq41rzifG4hmp5iczjrdBZ/FWQQvkkrH2HGtL80lMhkYr5+UqV63DaBdtoaReDtA=="
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
