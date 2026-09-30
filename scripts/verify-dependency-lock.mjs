import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const lockfile = await readFile(new URL('pnpm-lock.yaml', root), 'utf8')

const releases = {
  "@iris/svelte-ui": {
    "url": "https://github.com/mmalmi/iris-kit/releases/download/runtime-v0.2.5/iris-svelte-ui-0.1.2.tgz",
    "integrity": "sha512-noT2jG+eDoZ+m7GI0+hUvE4obpClkSWdRLomw8zkyaEvcTjnkzGlndw7W0xX49Qv4iMF0ewXkMJcz+NBpdt9yQ=="
  },
  "@iris/identity": {
    "url": "https://github.com/mmalmi/iris-kit/releases/download/runtime-v0.2.5/iris-identity-0.3.1.tgz",
    "integrity": "sha512-HwLi00j/Buf85f//Q4FsKCzvDcidul2U+rNIkfwHZjusNPfJaw6p/Yk4nlKXGkpN4W+TGVj1tZmHGj9Tz8UBAg=="
  },
  "@iris/hashtree-app": {
    "url": "https://github.com/mmalmi/iris-kit/releases/download/runtime-v0.2.5/iris-hashtree-app-0.1.4.tgz",
    "integrity": "sha512-OCyupIE19tdT7BzOMtC4JuiiRw7ozus1FVKV0HuEPbwF83FBG5VqTKvoUZipIMtngSAFVDlR9unKdHzKjMOlRw=="
  },
  "@hashtree/core": {
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.9/hashtree-core-0.3.2.tgz",
    "integrity": "sha512-OLd2ARbYKt9s7wipMX58OhJwZQ6XwIdkuJ+Zfp+NNz3rjXDV8kYl67S9HlrXOj5eSsy5SbN/JuKS8QuwXzEiRQ=="
  },
  "@hashtree/dexie": {
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.9/hashtree-dexie-0.1.11.tgz",
    "integrity": "sha512-NGe+rKVuyBrhlWeIemO0Hzd/mAcuN+PqpXYeg508dlvwuRrl+0GNIwRwPVh7e7Zg5VlwiKaN6E5itp9W6EZEGg=="
  },
  "@hashtree/worker": {
    "url": "https://github.com/mmalmi/hashtree/releases/download/hashtree-ts-runtime-v0.5.9/hashtree-worker-0.4.5.tgz",
    "integrity": "sha512-b6DPm6KwiBy31s+Uz6y+MDakp8mP4HLXWi7wxhB8YapbkiRPB9XOdn9eSgPL2sUMkO/uFCKGnqEF6uQ4Et/5Tg=="
  },
  "nostr-pubsub": {
    "url": "https://github.com/mmalmi/nostr-pubsub/releases/download/nostr-pubsub-ts-v0.5.11/nostr-pubsub-0.5.11.tgz",
    "integrity": "sha512-wyHDPvyDPSQo6JRuof5tx5Mn2WdA6W6asiGR+VEKF9hRKGNfobAcbWlShGtCmJFLa/tjAVj8vY5tGbxfrgOJrQ=="
  },
  "nostr-social-graph": {
    "url": "https://github.com/mmalmi/nostr-social-graph/releases/download/v2.0.1/nostr-social-graph-2.0.1.tgz",
    "integrity": "sha512-7bR840Fmz7wYaHi0P9fXxxKlQSphFARmj2VBMIQdFvrNT584bj6ci18GaeJ49OghutUot/FwHmPOTjYqmg6koA=="
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
