import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
const lockfile = await readFile(new URL('pnpm-lock.yaml', root), 'utf8')

const releases = {
  '@iris/svelte-ui': {
    url: 'https://github.com/mmalmi/iris-kit/releases/download/runtime-v0.2.1/iris-svelte-ui-0.1.1.tgz',
    integrity: 'sha512-6ZjpDXTDXg7GjBE6i8ESc/mgU0LZ+0JQLsB1HGWP6MOnzSPNk1fE2suKfc+9tftazIMiPGVKrRUvCw0Muct1nQ==',
  },
  ndk: {
    url: 'https://github.com/mmalmi/iris-kit/releases/download/runtime-v0.2.2/ndk-0.2.1.tgz',
    integrity: 'sha512-ipX47l/sNwq8uq3xrUabLFEhxExaaiQg7Q7KO/ik3e3bdTlW3fLtvfsb3k21uLjGdf0c179k/m0i8oqYnfSQ2A==',
  },
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

for (const script of ['build', 'check', 'test', 'test:e2e', 'publish:iris', 'release:iris']) {
  if (!manifest.scripts?.[script]?.startsWith('pnpm run verify:dependency-lock')) {
    throw new Error(`${script} must verify immutable dependency integrity first`)
  }
}

console.log('Verified immutable Meet runtime release integrity')
