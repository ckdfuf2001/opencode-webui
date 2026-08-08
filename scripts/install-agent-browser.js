import { execFileSync } from 'node:child_process'
import { mkdirSync, existsSync, chmodSync, writeFileSync, rmSync, readdirSync, readFileSync, copyFileSync, cpSync } from 'node:fs'
import { join, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(root, 'bin', 'agent-browser')
const binDir = join(outDir, 'bin')
const chromeDir = join(outDir, 'chromium')
const metaFile = join(outDir, '.meta.json')

const platformKey = `${os.platform()}-${os.arch()}`

const AGENT_BROWSER_BIN = {
  'win32-x64': { pkg: 'agent-browser-win32-x64.exe', bin: 'agent-browser.exe' },
  'darwin-x64': { pkg: 'agent-browser-darwin-x64', bin: 'agent-browser' },
  'darwin-arm64': { pkg: 'agent-browser-darwin-arm64', bin: 'agent-browser' },
  'linux-x64': { pkg: 'agent-browser-linux-x64', bin: 'agent-browser' },
  'linux-arm64': { pkg: 'agent-browser-linux-arm64', bin: 'agent-browser' },
}

const CHROME_PLATFORM = {
  'win32-x64': 'win64',
  'darwin-x64': 'mac-x64',
  'darwin-arm64': 'mac-arm64',
  'linux-x64': 'linux64',
  'linux-arm64': 'linux-arm64',
}

const CHROME_EXE_NAMES = {
  win32: ['chrome.exe'],
  darwin: ['Google Chrome for Testing'],
  linux: ['chrome'],
}

function fail(msg) {
  console.error('[install-agent-browser] ' + msg)
  process.exit(1)
}

async function json(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + url)
  return res.json()
}

async function downloadTo(url, dest) {
  const res = await fetch(url)
  if (!res.ok) throw new Error('Download failed (' + res.status + '): ' + url)
  const bytes = new Uint8Array(await res.arrayBuffer())
  writeFileSync(dest, bytes)
  return bytes.length
}

function extractZip(archivePath, destDir) {
  if (process.platform === 'win32') {
    const ps = "Expand-Archive -LiteralPath '" + archivePath + "' -DestinationPath '" + destDir + "' -Force"
    execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit' })
  } else {
    execFileSync('unzip', ['-o', archivePath, '-d', destDir], { stdio: 'inherit' })
  }
}

function extractTar(archivePath, destDir) {
  execFileSync('tar', ['-xzf', archivePath, '-C', destDir], { stdio: 'inherit' })
}

function findFile(dir, names) {
  for (const name of names) {
    const stack = [dir]
    while (stack.length) {
      const current = stack.pop()
      let entries
      try {
        entries = readdirSync(current, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        const full = join(current, entry.name)
        if (entry.isDirectory()) {
          stack.push(full)
        } else if (name === entry.name) {
          return full
        }
      }
    }
  }
  return null
}

function rel(path) {
  return path.replaceAll('\\', '/').replace(root.replaceAll('\\', '/') + '/', '')
}

function copyDirContents(src, dest) {
  mkdirSync(dest, { recursive: true })
  for (const entry of readdirSync(src)) {
    cpSync(join(src, entry), join(dest, entry), { recursive: true })
  }
}

function pickExisting(...paths) {
  return paths.find((p) => existsSync(p)) ?? null
}

async function installAgentBrowser() {
  const force = process.argv.includes('--force')
  if (process.env.AGENT_BROWSER_INSECURE === '1' || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  }

  const binDef = AGENT_BROWSER_BIN[platformKey]
  const chromePlatform = CHROME_PLATFORM[platformKey]
  if (!binDef || !chromePlatform) {
    fail('unsupported platform "' + platformKey + '". Supported: ' + Object.keys(AGENT_BROWSER_BIN).join(', '))
  }

  const outBin = join(binDir, binDef.bin)
  const meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, 'utf8')) : null

  if (!force && existsSync(outBin) && meta?.executable && existsSync(join(root, meta.executable))) {
    console.log('[install-agent-browser] agent-browser already present (' + (meta.agentBrowserVersion === 'vendor' ? 'vendor' : 'v' + meta.agentBrowserVersion ?? '?') + ').')
    console.log('  Update with: npm run agent-browser:update')
    return
  }

  mkdirSync(binDir, { recursive: true })
  mkdirSync(chromeDir, { recursive: true })

  const vendorAgentDir = join(root, 'vendor', 'agent-browser')
  const vendorChromeDir = join(root, 'vendor', 'chromium')

  console.log('[install-agent-browser] installing agent-browser + Chromium (Chrome for Testing)')

  let binaryVersion = 'download'
  const vendorBin = pickExisting(join(vendorAgentDir, binDef.pkg), join(vendorAgentDir, binDef.bin))
  if (vendorBin) {
    copyFileSync(vendorBin, outBin)
    binaryVersion = 'vendor'
    console.log('  [vendor] binary copied from ' + rel(vendorBin))
  } else {
    const pkgVersion = process.env.AGENT_BROWSER_VERSION || (await json('https://registry.npmjs.org/agent-browser/latest')).version
    binaryVersion = pkgVersion
    const tarballUrl = 'https://registry.npmjs.org/agent-browser/-/agent-browser-' + pkgVersion + '.tgz'
    const tarballPath = join(os.tmpdir(), 'agent-browser-' + pkgVersion + '.tgz')
    console.log('  [download] ' + tarballUrl)
    await downloadTo(tarballUrl, tarballPath)

    const pkgExtract = join(os.tmpdir(), 'agent-browser-pkg-' + pkgVersion)
    rmSync(pkgExtract, { recursive: true, force: true })
    mkdirSync(pkgExtract, { recursive: true })
    extractTar(tarballPath, pkgExtract)

    const packagedBin = findFile(pkgExtract, [binDef.pkg])
    if (!packagedBin) fail('could not find ' + binDef.pkg + ' inside the npm package')
    copyFileSync(packagedBin, outBin)
  }
  if (process.platform !== 'win32') chmodSync(outBin, 0o755)

  let chromiumVersion = ''
  const vendorChromeZip = join(vendorChromeDir, 'chrome-' + chromePlatform + '.zip')
  const vendorChromeExe = findFile(vendorChromeDir, CHROME_EXE_NAMES[process.platform])
  if (existsSync(vendorChromeZip) || vendorChromeExe) {
    rmSync(chromeDir, { recursive: true, force: true })
    mkdirSync(chromeDir, { recursive: true })
    if (existsSync(vendorChromeZip)) {
      console.log('  [vendor] chromium archive copied from ' + rel(vendorChromeZip))
      extractZip(vendorChromeZip, chromeDir)
    } else {
      console.log('  [vendor] chromium directory copied from ' + rel(vendorChromeDir))
      copyDirContents(vendorChromeDir, chromeDir)
    }
    chromiumVersion = 'vendor'
  } else {
    const cft = await json('https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json')
    const stable = cft?.channels?.Stable
    chromiumVersion = stable?.version
    const chromeDownload = stable?.downloads?.chrome?.find((d) => d.platform === chromePlatform)
    if (!chromiumVersion || !chromeDownload?.url) {
      fail('could not resolve Chrome for Testing download for platform ' + chromePlatform)
    }
    const chromeArchive = join(os.tmpdir(), 'chrome-' + chromePlatform + '.zip')
    console.log('  [download] Chromium ' + chromiumVersion + ' (' + chromePlatform + ')')
    await downloadTo(chromeDownload.url, chromeArchive)
    rmSync(chromeDir, { recursive: true, force: true })
    mkdirSync(chromeDir, { recursive: true })
    extractZip(chromeArchive, chromeDir)
  }

  const chromeExe = findFile(chromeDir, CHROME_EXE_NAMES[process.platform])
  if (!chromeExe) fail('could not locate the Chromium executable')

  writeFileSync(
    metaFile,
    JSON.stringify(
      {
        agentBrowserVersion: binaryVersion,
        chromiumVersion,
        bin: rel(outBin),
        executable: rel(chromeExe),
        platform: platformKey,
      },
      null,
      2,
    ),
  )

  console.log('[install-agent-browser] installed:')
  console.log('  binary    -> ' + outBin + ' (' + (binaryVersion === 'vendor' ? 'vendor' : 'v' + binaryVersion) + ')')
  console.log('  chromium  -> ' + chromeExe + ' (' + (chromiumVersion === 'vendor' ? 'vendor' : 'v' + chromiumVersion) + ')')
  console.log('  update with: npm run agent-browser:update')
}

installAgentBrowser().catch((error) => {
  console.error('[install-agent-browser] installation failed:', error)
  if (error && error.cause && error.cause.code === 'SELF_SIGNED_CERT_IN_CHAIN') {
    console.error('\nThis machine routes traffic through a TLS-intercepting proxy/corporate certificate.')
    console.error('Re-run with AGENT_BROWSER_INSECURE=1 to trust the proxy certificate for this one-time download:')
    console.error('    $env:AGENT_BROWSER_INSECURE="1"; npm run agent-browser:install')
  }
  console.error('\nAlternatively set AGENT_BROWSER_VERSION=<x.y.z> to pin a specific agent-browser release.')
  console.error('\nOffline: put your files under vendor/agent-browser/ and vendor/chromium/ (see vendor/README.md) and this installer copies them without any download.')
  process.exit(1)
})
