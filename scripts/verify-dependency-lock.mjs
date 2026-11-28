import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const lockfile = await readFile(new URL('pnpm-lock.yaml', root), 'utf8')

const releases = {
  "@fips/core": {
    "url": "https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.67/fips-core-0.0.62.tgz",
    "integrity": "sha512-nhmnwt0CULZUVB0gvILlP3QtLzV44jx0veQjyAtWt4CZsDg/u2ij1AsBbThxodgSkmeg7BaynpbHlzR7RoHEaQ=="
  },
  "@fips/transport-webrtc": {
    "url": "https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.67/fips-transport-webrtc-0.0.66.tgz",
    "integrity": "sha512-1/36va6D8Ifcgs0pnd5RQ3wm8x9/vEjTW1p9Eu6e4tztoTtywqjXI9uTAWgpVbNY/88wQTD9kq2stO8iW0Octg=="
  },
  "@fips/transport-websocket": {
    "url": "https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.67/fips-transport-websocket-0.0.20.tgz",
    "integrity": "sha512-uXpPKMjAXKteHWiPfSvHjBGGfwgZ5Y3IFTO52eYOjh4EqVeHWxNbV2RBYvAP+49paFw88D+JySYLrUWRHy56Hg=="
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
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.42/hashtree-core-0.4.2.tgz",
    "integrity": "sha512-9gPIe39QJoCUtVo8VhbDOX5bHAtGlJ2EZlQJqKh3l9++2CY1Njg2LINXQWBgKRqB0P2LBKoDpyYz1XIBoJ/SMw=="
  },
  "@hashtree/dexie": {
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.46/hashtree-dexie-0.1.15.tgz",
    "integrity": "sha512-YPn2gh0QQQRMcZY3zYmkycLqBjKJhA8GEmWq2/LPSbD0441YEQPCkWvTfAgRUsXA+gvjxB51tvqev1caXylp8A=="
  },
  "@hashtree/worker": {
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.53/hashtree-worker-0.4.34.tgz",
    "integrity": "sha512-ULYVXSmGJl2+1n+5JoYkdsZJQN7nq5JXNRGtkqPpkVoBjzSC1SGHQKVtgLi5qt2u5C6mRwVHdl6r3jfJQHIBAA=="
  },
  "nostr-pubsub": {
    "url": "https://github.com/mmalmi/nostr-pubsub/releases/download/nostr-pubsub-ts-v0.5.42/nostr-pubsub-0.5.42.tgz",
    "integrity": "sha512-kuEV8FVRU3zPtwTgG95JhztEkPBPV4wQ8Jv+pD6EHF/UfKS/3RpsB/q/+yd6ms9CM/obdbh6xNItOUrSvvBusw=="
  },
  "nostr-social-graph": {
    "url": "https://github.com/mmalmi/nostr-social-graph/releases/download/v4.2.6/nostr-social-graph-4.2.6.tgz",
    "integrity": "sha512-JND4ImunW/tH8SotXjWqvgXH0sCEX2xYiRHwAWnBRN2zkDk0WPmMcrK3qBIztGML03uMv4Dfjl8M5K/ykBKz1A=="
  },
  "@hashtree/index": {
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.27/hashtree-index-0.1.15.tgz",
    "integrity": "sha512-EnXs4hE0fxCzQfruEsjO9YVBTpzb3Rr1k1vF6p7gLgpZ2oIEg4DEv/pZji9uj7/qJYqOa+EsZTjA0lT0SZozdA=="
  },
  "@hashtree/collection": {
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.27/hashtree-collection-0.2.11.tgz",
    "integrity": "sha512-FI6cVBneXSgOEAEeZH6Yv12eC+pZpG2kTCHc9Bt4+bW6Vu0nVNo5V3Gtt5Dk9p8l7G47sq/R9CBbo6A0D+dVwA=="
  },
  "@hashtree/mesh": {
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.27/hashtree-mesh-0.3.3.tgz",
    "integrity": "sha512-fiLvKjbEO1J/fuj6wcLGjI3RPsPrGgSuc2O+QqN/vX3OSHI7uPS+feH49vFduUMHYM79Yvsrq6MV2XDUiGq59A=="
  },
  "@hashtree/nostr": {
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.40/hashtree-nostr-0.2.7.tgz",
    "integrity": "sha512-ah0pS1PDckTkz/QntsNn9D9aFPcJWb7BDjBvaVtY9gaWryiWMvXv0QaGbTU5aGIqRd32BLmnojNDXHPJ/IkIhQ=="
  },
  "@hashtree/nostr-pubsub": {
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.53/hashtree-nostr-pubsub-0.1.12.tgz",
    "integrity": "sha512-nwn5lRLx9RqVLFmsDmLc/eXq43L46DcSBecrYqu4Lh2lMe6VLDaL8LkqPdfmAnSUMqyfmePYT/OVsNqBdYG7Nw=="
  },
  "@fips/browser": {
    "url": "https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.67/fips-browser-0.0.27.tgz",
    "integrity": "sha512-++9RRUijRnyiKy8QFTIGc/tUkqDrpWKis5M2Tw51WF9O9eMxPjYLRs1fApSlw6l51ZufFJ+H7UdbDNYaLmIKzA=="
  },
  "@fips/transport-ethernet": {
    "url": "https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.67/fips-transport-ethernet-0.0.44.tgz",
    "integrity": "sha512-gTm5+p/StSjEYmW4tIx4MtLxjqFsefKbB2TtkMswiEcWehH8QNs9NOSKgeHmD84DELhMLSMVVcF+ZJ8u2m6Waw=="
  },
  "@fips/transport-memory": {
    "url": "https://github.com/mmalmi/fips-ts/releases/download/runtime-v0.0.67/fips-transport-memory-0.0.22.tgz",
    "integrity": "sha512-Px083zQ69ee0OMD1n6RvUntFezGg3H0pSRGHIw0L+V9VyU3NZKM9Caz5Yg+TSSgdanwhTyWdJArH6nmyHdScbw=="
  },
  "@fips/tcp": {
    "url": "https://github.com/mmalmi/fips-tcp/releases/download/fips-tcp-ts-v0.2.6/fips-tcp-0.2.6.tgz",
    "integrity": "sha512-lXQHNwTZEyXGYWqzRlNyKpb2UgNWJOon6HljbY1F1Ey49Q9IoE/kdF84gaTkrCpMPS8M/A6y5FTaFPOLl60+bw=="
  }
}

const directReleases = new Set([
  '@fips/core', '@fips/transport-webrtc', '@fips/transport-websocket',
  '@iris/svelte-ui', '@iris/identity', '@hashtree/core', '@hashtree/dexie',
  '@hashtree/worker', 'nostr-pubsub', 'nostr-social-graph',
])
const packages = lockfile.split('\npackages:\n')[1]?.split('\nsnapshots:\n')[0] ?? ''
const packageKeys = [...packages.matchAll(/^  '?([^'\n]+?)'?:\s*$/gm)].map(match => match[1])

for (const [name, release] of Object.entries(releases)) {
  if ((directReleases.has(name) || manifest.dependencies?.[name] !== undefined) && manifest.dependencies?.[name] !== release.url) {
    throw new Error(`${name} must use immutable release ${release.url}`)
  }

  const cohort = name.startsWith('@hashtree/') || name.startsWith('@fips/') || ['nostr-pubsub', 'nostr-social-graph'].includes(name)
  if (cohort && manifest.pnpm?.overrides?.[name] !== release.url) {
    throw new Error(`${name} must pin direct and nested consumers with a root override`)
  }
  const key = `${name}@${release.url}`
  const resolutions = packageKeys.filter(value => value.startsWith(`${name}@`))
  if (resolutions.some(value => value !== key)) {
    throw new Error(`${name} has an unapproved nested resolution`)
  }
  // Some complete FIPS cohort overrides are not reached by this browser app.
  if (!resolutions.length && manifest.dependencies?.[name] === undefined) continue
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
