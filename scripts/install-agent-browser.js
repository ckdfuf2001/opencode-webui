import { execFileSync } from 'node:child_process'
import { mkdirSync, existsSync, chmodSync, writeFileSync, rmSync, readdirSync, readFileSync, copyFileSync } from 'node:fs'
import { join, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(root, 'bin', 'agent-browser')
const binDir = join(outDir, 'bin')
const chromeDir = join(outDir, 'chromium')
const metaFile = join(outDir, '.meta.json')

const AGENT_BROWSER_GITHUB_REPO = process.env.AGENT_BROWSER_GITHUB_REPO || 'ckdfuf2001/agent-browser'

const platformKey = `${os.platform()}-${os.arch()}`

const AGENT_BROWSER_BIN = {
  'win32-x64': { pkg: 'agent-browser-win32-x64.exe', bin: 'agent-browser.exe' },
  'darwin-x64': { pkg: 'agent-browser-darwin-x64', bin: 'agent-browser' },
  'darwin-arm64': { pkg: 'agent-browser-darwin-arm64', bin: 'agent-browser' },
  'linux-x64': { pkg: 'agent-browser-linux-x64', bin: 'agent-browser' },
  'linux-arm64': { pkg: 'agent-browser-linux-arm64', bin: 'agent-browser' },
}

// v0.35 릴리즈는 플랫폼 접미사 없는 generic 이름(agent-browser.exe)으로만
// 업로드되어 있다. 플랫폼별 후보를 순서대로 찾아본다.
const AGENT_BROWSER_ASSET_NAMES = {
  'win32-x64': ['agent-browser-win32-x64.exe', 'agent-browser.exe'],
  'darwin-x64': ['agent-browser-darwin-x64', 'agent-browser'],
  'darwin-arm64': ['agent-browser-darwin-arm64', 'agent-browser'],
  'linux-x64': ['agent-browser-linux-x64', 'agent-browser'],
  'linux-arm64': ['agent-browser-linux-arm64', 'agent-browser'],
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

async function resolveBinarySource(pkg) {
  // 1) fork latest에 플랫폼 raw 바이너리가 있으면 그대로 (직접 다운로드).
  //    v0.35처럼 generic 이름(agent-browser.exe)만 있는 릴리즈도 후보로 찾는다.
  // 2) 없으면 핀된 네임스페이스 빌드 릴리즈에서 찾는다.
  //    (latest가 proxy-v2.2.0처럼 zip만 있는 릴리즈일 수 있어서 latest 고정이 깨진다)
  // 3) proxy 릴리즈의 플랫폼 zip (win32: agent-browser-win32-x64-0.33.2.zip).
  // 4) 최후: npm upstream (포크 기능 없음).
  const candidates = AGENT_BROWSER_ASSET_NAMES[platformKey] || [pkg]
  const findAsset = (release) => {
    if (!release?.assets) return null
    for (const name of candidates) {
      const asset = release.assets.find((a) => a.name === name)
      if (asset?.browser_download_url) return asset
    }
    return null
  }
  if (!process.env.AGENT_BROWSER_VERSION) {
    try {
      const latest = await json(`https://api.github.com/repos/${AGENT_BROWSER_GITHUB_REPO}/releases/latest`)
      const asset = findAsset(latest)
      if (asset) {
        return { version: latest.tag_name, url: asset.browser_download_url, tarball: false, zip: false, source: 'github' }
      }
    } catch {
      // 아래 폴백 계속
    }
    const pinnedTag = process.env.AGENT_BROWSER_RELEASE_TAG || 'v0.35'
    try {
      const pinned = await json(`https://api.github.com/repos/${AGENT_BROWSER_GITHUB_REPO}/releases/tags/${pinnedTag}`)
      const asset = findAsset(pinned)
      if (asset) {
        console.log('[install-agent-browser] using pinned release ' + pinnedTag)
        return { version: pinned.tag_name, url: asset.browser_download_url, tarball: false, zip: false, source: 'github' }
      }
    } catch {
      // 아래 폴백 계속
    }
    const proxyZips = { 'win32-x64': 'agent-browser-win32-x64-0.33.2.zip' }
    const proxyZip = proxyZips[platformKey]
    if (proxyZip) {
      try {
        const proxyRel = await json(`https://api.github.com/repos/${AGENT_BROWSER_GITHUB_REPO}/releases/tags/proxy-v2.2.0`)
        const asset = proxyRel?.assets?.find((a) => a.name === proxyZip)
        if (asset?.browser_download_url) {
          console.log('[install-agent-browser] using proxy release stock binary ' + proxyZip)
          return { version: proxyRel.tag_name, url: asset.browser_download_url, tarball: false, zip: true, source: 'github' }
        }
      } catch {
        // 아래 폴백 계속
      }
    }
    console.warn(
      '[install-agent-browser] WARN: no fork binary found for platform "' + platformKey + '".',
    )
    console.warn(
      '  Falling back to the npm package (upstream agent-browser), which does NOT include',
    )
    console.warn(
      '  the fork changes (session proxy / namespace mode).',
    )
  }
  const pkgVersion = process.env.AGENT_BROWSER_VERSION || (await json('https://registry.npmjs.org/agent-browser/latest')).version
  return {
    version: pkgVersion,
    url: `https://registry.npmjs.org/agent-browser/-/agent-browser-${pkgVersion}.tgz`,
    tarball: true,
    zip: false,
    source: 'npm',
  }
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

  const binaryLabel = (v) => (v?.startsWith('v') ? v : 'v' + v)

  if (!force && existsSync(outBin) && meta?.executable && existsSync(join(root, meta.executable))) {
    console.log('[install-agent-browser] agent-browser already present (' + binaryLabel(meta.agentBrowserVersion) + ').')
    console.log('  Update with: npm run agent-browser:update')
    return
  }

  mkdirSync(binDir, { recursive: true })
  mkdirSync(chromeDir, { recursive: true })

  console.log('[install-agent-browser] installing agent-browser + Chromium (Chrome for Testing)')

  const source = await resolveBinarySource(binDef.pkg)
  const binaryVersion = source.version
  console.log('  [download] ' + source.url)
  if (source.tarball) {
    const tarballPath = join(os.tmpdir(), 'agent-browser-' + source.version + '.tgz')
    await downloadTo(source.url, tarballPath)

    const pkgExtract = join(os.tmpdir(), 'agent-browser-pkg-' + source.version)
    rmSync(pkgExtract, { recursive: true, force: true })
    mkdirSync(pkgExtract, { recursive: true })
    extractTar(tarballPath, pkgExtract)

    const packagedBin = findFile(pkgExtract, [binDef.pkg])
    if (!packagedBin) fail('could not find ' + binDef.pkg + ' inside the npm package')
    copyFileSync(packagedBin, outBin)
  } else if (source.zip) {
    const zipPath = join(os.tmpdir(), 'agent-browser-' + source.version + '.zip')
    await downloadTo(source.url, zipPath)

    const zipExtract = join(os.tmpdir(), 'agent-browser-zip-' + source.version)
    rmSync(zipExtract, { recursive: true, force: true })
    mkdirSync(zipExtract, { recursive: true })
    extractZip(zipPath, zipExtract)

    const zippedBin = findFile(zipExtract, [binDef.bin])
    if (!zippedBin) fail('could not find ' + binDef.bin + ' inside ' + source.url)
    copyFileSync(zippedBin, outBin)
  } else {
    await downloadTo(source.url, outBin)
  }
  if (process.platform !== 'win32') chmodSync(outBin, 0o755)

  const cft = await json('https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json')
  const stable = cft?.channels?.Stable
  const chromiumVersion = stable?.version
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
  console.log('  binary    -> ' + outBin + ' (' + binaryLabel(binaryVersion) + ')')
  console.log('  chromium  -> ' + chromeExe + ' (' + 'v' + chromiumVersion + ')')
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
  console.error('\nSet AGENT_BROWSER_GITHUB_REPO to pull the binary from a different GitHub release source (default: ckdfuf2001/agent-browser).')
  process.exit(1)
})
