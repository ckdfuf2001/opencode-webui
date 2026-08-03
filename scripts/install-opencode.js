import { execFileSync } from 'node:child_process'
import { mkdirSync, existsSync, chmodSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(root, 'bin')
const platformKey = `${os.platform()}-${os.arch()}`

const ASSETS = {
  'win32-x64': { file: 'opencode-windows-x64.zip', bin: 'opencode.exe', type: 'zip' },
  'win32-arm64': { file: 'opencode-windows-arm64.zip', bin: 'opencode.exe', type: 'zip' },
  'darwin-x64': { file: 'opencode-darwin-x64.zip', bin: 'opencode', type: 'zip' },
  'darwin-arm64': { file: 'opencode-darwin-arm64.zip', bin: 'opencode', type: 'zip' },
  'linux-x64': { file: 'opencode-linux-x64.tar.gz', bin: 'opencode', type: 'txz', },
  'linux-arm64': { file: 'opencode-linux-arm64.tar.gz', bin: 'opencode', type: 'txz', },
}

function fail(msg) {
  console.error('[install-opencode] ' + msg)
  process.exit(1)
}

async function latestTag() {
  const res = await fetch('https://api.github.com/repos/sst/opencode/releases/latest')
  if (!res.ok) throw new Error('GitHub API responded ' + res.status)
  const data = await res.json()
  if (!data.tag_name) throw new Error('No tag_name in release response')
  return data.tag_name
}

async function main() {
  const assetDef = ASSETS[platformKey]
  if (!assetDef) {
    fail('unsupported platform "' + platformKey + '". Place the opencode binary manually at ' + outDir)
  }

  const outBin = join(outDir, assetDef.bin)
  if (existsSync(outBin)) {
    console.log('[install-opencode] opencode already present: ' + outBin)
    return
  }

  mkdirSync(outDir, { recursive: true })

  const tag = process.env.OPENCODE_VERSION ? 'v' + process.env.OPENCODE_VERSION : (await latestTag().catch(() => 'latest'))
  const url = 'https://github.com/sst/opencode/releases/download/' + tag + '/' + assetDef.file
  console.log('[install-opencode] downloading ' + url)

  const res = await fetch(url)
  if (!res.ok) throw new Error('Download failed (' + res.status + '): ' + url)
  const archiveBytes = new Uint8Array(await res.arrayBuffer())

  const archivePath = join(os.tmpdir(), assetDef.file)
  writeFileSync(archivePath, archiveBytes)

  if (assetDef.type === 'zip') {
    if (process.platform === 'win32') {
      const ps = "Expand-Archive -LiteralPath '" + archivePath + "' -DestinationPath '" + outDir + "' -Force"
      execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit' })
    } else {
      execFileSync('unzip', ['-o', archivePath, '-d', outDir], { stdio: 'inherit' })
    }
  } else {
    execFileSync('tar', ['-xzf', archivePath, '-C', outDir], { stdio: 'inherit' })
  }

  const installed = existsSync(outBin)
  if (installed) {
    if (process.platform !== 'win32') chmodSync(outBin, 0o755)
    console.log('[install-opencode] installed to ' + outBin)
  } else {
    console.warn('[install-opencode] extracted but did not find ' + assetDef.bin + '; inspect contents under ' + outDir)
  }
}

main().catch((error) => {
  console.error('[install-opencode] installation failed:', error)
  console.error('\nTip: place the opencode standalone binary at ' + outDir + ' (opencode.exe on Windows) and set the backend env OPENCODE_BIN to that file, or set OPENCODE_VERSION to a specific release.')
  process.exit(1)
})