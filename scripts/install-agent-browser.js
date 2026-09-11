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

// 원본(upstream) 우선: npm/MCP용 기본 바이너리는 vercel-labs 릴리즈에서 받는다.
// 포크 에셋은 AGENT_BROWSER_VERSION 지정 또는 upstream 실패 시 폴백으로만 쓴다.
const UPSTREAM_REPO = process.env.AGENT_BROWSER_UPSTREAM_REPO || 'vercel-labs/agent-browser'
const UPSTREAM_ASSET_NAMES = {
  'win32-x64': ['agent-browser-win32-x64.exe'],
  'darwin-x64': ['agent-browser-darwin-x64'],
  'darwin-arm64': ['agent-browser-darwin-arm64'],
  'linux-x64': ['agent-browser-linux-x64'],
  'linux-arm64': ['agent-browser-linux-arm64'],
}

async function resolveUpstreamLatest() {
  const names = UPSTREAM_ASSET_NAMES[platformKey] || []
  const latest = await json(`https://api.github.com/repos/${UPSTREAM_REPO}/releases/latest`)
  const asset = (latest?.assets || []).find((a) => names.includes(a.name) && a.browser_download_url)
  if (!asset) throw new Error('no upstream asset for platform "' + platformKey + '"')
  return { version: latest.tag_name, url: asset.browser_download_url }
}

// (구 포크 핀: AGENT_BROWSER_RELEASE_TAG 지정 시 fork 폴백에서 사용)
const PINNED_TAG = process.env.AGENT_BROWSER_RELEASE_TAG || 'v0.35'

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
  // 1) 원본 upstream latest (기본). 포크의 namespace 모드는 upstream에 없음에
  //    유의 — 우리 프록시는 세션별 데몬(upstream 모델)으로 동작한다.
  // 2) 없으면 핀된 포크 릴리즈에서 찾는다.
  // 3) 최후: npm upstream (포크 기능 없음).
  if (!process.env.AGENT_BROWSER_VERSION) {
    try {
      const up = await resolveUpstreamLatest()
      console.log('[install-agent-browser] using upstream ' + up.version)
      return { version: up.version, url: up.url, tarball: false, zip: false, source: 'upstream' }
    } catch (e) {
      console.warn('[install-agent-browser] WARN: upstream resolve failed (' + ((e && e.message) || e) + '), trying fork fallback')
    }
  }
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

  function installedBinaryRuns() {
    try {
      execFileSync(outBin, ['--version'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] })
      return true
    } catch {
      return false
    }
  }

  const present =
    !force && existsSync(outBin) && meta?.executable && existsSync(join(root, meta.executable))

  if (present) {
    if (!installedBinaryRuns()) {
      console.log('[install-agent-browser] present binary does not run, reinstalling...')
    } else if (!process.argv.includes('--auto-upgrade')) {
      console.log('[install-agent-browser] agent-browser already present (' + binaryLabel(meta.agentBrowserVersion) + (meta.binaryVersion ? ' / binary ' + meta.binaryVersion : '') + ').')
      console.log('  Update with: npm run agent-browser:update')
      return
    } else {
      // --auto-upgrade (setup-dev 기동 단계): latest와 다르면 재설치.
      // 네트워크 실패면 경고만 하고 기존 유지 (fail-open).
      let want = null
      try {
        want = process.env.AGENT_BROWSER_VERSION
          ? { version: process.env.AGENT_BROWSER_VERSION }
          : await resolveUpstreamLatest()
      } catch (e) {
        console.warn('[install-agent-browser] WARN: auto-upgrade check failed (' + ((e && e.message) || e) + '), keeping present install')
        return
      }
      const wantTag = want.version.startsWith('v') ? want.version : 'v' + want.version
      if (meta.agentBrowserVersion === wantTag && meta.source === 'upstream') {
        console.log('[install-agent-browser] already at latest (' + wantTag + ').')
        return
      }
      console.log('[install-agent-browser] updating ' + (meta.agentBrowserVersion || 'unknown') + ' -> ' + wantTag + '...')
    }
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

  // --version은 내부 버전(포크 태그와 다를 수 있음)을 보여준다.
  // 릴리즈 태그와 구분되도록 둘 다 + 출처 기록한다.
  let installedBinaryVersion = null
  try {
    const out = execFileSync(outBin, ['--version'], { encoding: 'utf8', timeout: 15000 })
    const m = String(out).match(/(\d+\.\d+\.\d+)/)
    if (m) installedBinaryVersion = m[1]
  } catch {
    // 메타 기록 실패는 치명적이지 않음
  }

  writeFileSync(
    metaFile,
    JSON.stringify(
      {
        agentBrowserVersion: binaryVersion,
        binaryVersion: installedBinaryVersion,
        source: source.source || 'unknown',
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
