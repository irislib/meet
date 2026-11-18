import { statSync } from 'node:fs'
import path from 'node:path'

/**
 * @param {...string} args
 * @returns {string[]}
 */
export function resolveHtreeCommand(...args) {
  return [process.env.HTREE_BIN || 'htree', ...args]
}

/**
 * @param {string} distDir
 * @param {string} treeName
 * @param {{ dryRun?: boolean }} [options]
 * @returns {string[]}
 */
export function resolveNativePublishCommand(distDir, treeName, options = {}) {
  const { dryRun = false } = options
  const entrypoint = process.env.IRIS_NATIVE_RELEASE_GATE
  if (!dryRun && (!entrypoint || !path.isAbsolute(entrypoint) || !statSync(entrypoint, { throwIfNoEntry: false })?.isFile())) {
    throw new Error('Set IRIS_NATIVE_RELEASE_GATE to the absolute path of the pinned Iris Sites gate')
  }
  const publisher = resolveHtreeCommand()
  if (publisher.length !== 1 && !dryRun) {
    throw new Error('Set HTREE_BIN to the verified standalone Hashtree publisher')
  }
  return [
    process.execPath, entrypoint ?? '<IRIS_NATIVE_RELEASE_GATE>',
    '--dist', distDir, '--tree', treeName,
    '--htree', publisher.length === 1 ? publisher[0] : '<HTREE_BIN>',
  ]
}
