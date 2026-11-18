// @vitest-environment node

import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createReleasePlan, parseArgs } from '../scripts/release-site.mjs'

describe('release site config', () => {
  afterEach(() => vi.unstubAllEnvs())
  it('installs the frozen graph and publishes with the installed htree release', () => {
    vi.stubEnv('HTREE_BIN', '/fixture/verified-htree')
    vi.stubEnv('IRIS_NATIVE_RELEASE_GATE', fileURLToPath(import.meta.url))
    const plan = createReleasePlan(parseArgs(['--skip-cloudflare']))

    expect(plan.steps[0]).toMatchObject({
      id: 'install',
      command: ['pnpm', 'install', '--frozen-lockfile'],
    })
    expect(plan.steps.find((step) => step.id === 'publish')?.command).toEqual([
      process.execPath,
      fileURLToPath(import.meta.url),
      '--dist',
      plan.steps.find((step) => step.id === 'publish')?.cwd,
      '--tree',
      'meet-site',
      '--htree',
      '/fixture/verified-htree',
    ])
  })
})
