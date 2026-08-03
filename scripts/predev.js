import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const isWindows = process.platform === 'win32'
const script = join(root, isWindows ? 'setup-dev.bat' : 'setup-dev.sh')

const result = isWindows
  ? spawnSync('cmd', ['/c', script], { stdio: 'inherit' })
  : spawnSync('sh', [script], { stdio: 'inherit' })

if (result.error) {
  console.error('Failed to run setup script:', result.error)
  process.exit(1)
}
process.exit(result.status ?? 1)