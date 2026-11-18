// @vitest-environment node

import { afterEach, describe, expect, it, vi } from 'vitest'

import { createReleasePlan, parseArgs } from '../scripts/release-site.mjs'

describe('release site config', () => {
  afterEach(() => vi.unstubAllEnvs())
  it('installs the frozen graph and publishes with the installed htree release', () => {
    vi.stubEnv('HTREE_BIN', '/fixture/verified-htree')
    const plan = createReleasePlan(parseArgs(['--skip-cloudflare']))

    expect(plan.steps[0]).toMatchObject({
      id: 'install',
      command: ['pnpm', 'install', '--frozen-lockfile'],
    })
    expect(plan.steps.find((step) => step.id === 'publish')?.command).toEqual([
      '/fixture/verified-htree',
      'add',
      '.',
      '--publish',
      'meet-site',
    ])
  })
})
