// @vitest-environment node

import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it, vi } from 'vitest'

async function loadViteConfig() {
  vi.resetModules()
  const configModule = await import('../vite.config')
  return configModule.default
}

describe('portable build config', () => {
  it('uses a relative base for portable static hosting', async () => {
    const config = await loadViteConfig()
    expect(config.base ?? '/').toBe('./')
  })

  it('keeps the HTML entrypoint free of root-absolute asset refs', () => {
    const indexHtml = fs.readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf8')

    expect(indexHtml).not.toContain('href="/')
    expect(indexHtml).not.toContain('src="/')
  })

  it('uses dedicated Iris Meet icon assets', async () => {
    await loadViteConfig()

    expect(indexHtmlForTest()).toContain('href="./iris-meet-icon.svg"')
    expect(indexHtmlForTest()).toContain('href="./iris-meet-icon-180.png"')
    expect(configTextForTest()).toContain("includeAssets: ['iris-meet-icon.svg', 'iris-meet-icon-180.png', 'iris-meet-icon.png']")
    expect(configTextForTest()).toContain("src: 'iris-meet-icon-192.png'")
    expect(configTextForTest()).toContain("src: 'iris-meet-icon-512.png'")
    expect(configTextForTest()).toContain("src: 'iris-meet-icon-maskable.png'")
    expect(configTextForTest()).not.toContain("includeAssets: ['favicon.png', 'apple-touch-icon.png', 'iris-logo.png']")
    expect(appSourceForTest()).toContain('iris-meet-icon.svg')
    expect(appSourceForTest()).not.toContain('iris-logo.png')
  })

  it('links the footer source button to the published git.iris.to repo', () => {
    expect(appSourceForTest()).toContain('https://git.iris.to/#/npub1xdhnr9mrv47kkrn95k6cwecearydeh8e895990n3acntwvmgk2dsdeeycm/meet')
    expect(appSourceForTest()).not.toContain('https://github.com/irislib/meet')
  })
})

function indexHtmlForTest(): string {
  return fs.readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf8')
}

function configTextForTest(): string {
  return fs.readFileSync(path.resolve(process.cwd(), 'vite.config.ts'), 'utf8')
}

function appSourceForTest(): string {
  return fs.readFileSync(path.resolve(process.cwd(), 'src', 'App.svelte'), 'utf8')
}
