import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runPortableSmoke } from './portable-smoke-lib.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const appDir = path.resolve(__dirname, '..')
const distDir = path.join(appDir, 'dist')
const screenshotPath = path.join(appDir, 'test-results', 'meet-iris-portable-smoke.png')

async function main() {
  await runPortableSmoke({
    distDir,
    title: 'iris meet',
    screenshotPath,
    async validatePage(page) {
      await page.locator("img[src$='iris-meet-icon.svg']").first().waitFor({ state: 'visible', timeout: 15000 })
      await page.getByRole('button', { name: 'Join' }).waitFor({ state: 'visible', timeout: 15000 })
    },
  })
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
