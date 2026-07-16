// @vitest-environment node

import { describe, expect, it } from 'vitest'

import { createReleasePlan } from '../scripts/release-site.mjs'

describe('release site config', () => {
  it('installs the frozen graph and publishes with the installed htree release', () => {
    const plan = createReleasePlan({
      dryRun: false,
      skipCloudflare: true,
      pagesOnly: false,
      treeName: 'meet',
      branch: undefined,
      pagesProject: undefined,
      workerName: undefined,
      routes: [],
      domains: [],
      workerCompatibilityDate: '2026-03-26',
    })

    expect(plan.steps[0]).toMatchObject({
      id: 'install',
      command: ['pnpm', 'install', '--frozen-lockfile'],
    })
    expect(plan.steps.find((step) => step.id === 'publish')?.command).toEqual([
      'htree',
      'add',
      '.',
      '--publish',
      'meet',
    ])
  })
})
