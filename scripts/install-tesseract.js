import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const binTessDir = join(root, 'bin', 'tesseract')
const binTessExe = join(binTessDir, 'tesseract.exe')
const vendorDir = join(root, 'vendor', 'tesseract')
const VENDOR_ZIP = join(vendorDir, 'tesseract-ocr-w64.zip')
const VENDOR_EXE = join(vendorDir, 'tesseract-ocr-w64-setup.exe')

// UB-Mannheim Tesseract 5.4.0 portable installer (Windows x64) + tessdata
const TESSERACT_URL = process.env.TESSERACT_URL || 'https://github.com/UB-Mannheim/tesseract/releases/download/v5.4.0.20240606/tesseract-ocr-w64-setup-5.4.0.20240606.exe'
const TESSDATA_BASE = 'https://raw.githubusercontent.com/tesseract-ocr/tessdata/main'
const LANGS = ['eng', 'kor']

function log(msg) { console.log('[install-tesseract] ' + msg) }
function fail(msg) { console.error('[install-tesseract] ' + msg); process.exit(1) }

function ensureDir(p) { mkdirSync(p, { recursive: true }) }

async function download(url, dest) {
  log('[download] ' + url)
  const res = await fetch(url)
  if (!res.ok) throw new Error('Download failed (' + res.status + '): ' + url)
  const buf = Buffer.from(await res.arrayBuffer())
  writeFileSync(dest, buf)
  log('  -> ' + dest + ' (' + (buf.length / 1024 / 1024).toFixed(1) + ' MB)')
}

async function downloadTessdata() {
  const tessdataDir = join(binTessDir, 'tessdata')
  ensureDir(tessdataDir)
  for (const lang of LANGS) {
    const dest = join(tessdataDir, lang + '.traineddata')
    if (existsSync(dest)) { log('tessdata already present: ' + lang); continue }
    const url = TESSDATA_BASE + '/' + lang + '.traineddata'
    try {
      await download(url, dest)
    } catch (e) {
      console.warn('[install-tesseract] failed to download ' + lang + ': ' + e.message)
    }
  }
}

function tryVendorCopy() {
  if (existsSync(VENDOR_ZIP)) {
    log('[vendor] extracting ' + VENDOR_ZIP)
    try {
      execFileSync('powershell', ['-NoProfile', '-Command', "Expand-Archive -LiteralPath '" + VENDOR_ZIP + "' -DestinationPath '" + binTessDir + "' -Force"], { stdio: 'inherit' })
      return true
    } catch (e) { console.warn('[vendor] zip extract failed: ' + e.message); return false }
  }
  if (existsSync(VENDOR_EXE)) {
    log('[vendor] installing from ' + VENDOR_EXE)
    try {
      execFileSync(VENDOR_EXE, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-','/DIR=' + binTessDir], { stdio: 'inherit' })
      return true
    } catch (e) { console.warn('[vendor] exe install failed: ' + e.message); return false }
  }
  return false
}

async function main() {
  if (existsSync(binTessExe)) {
    log('already present: ' + binTessExe)
    await downloadTessdata()
    return
  }
  if (os.platform() !== 'win32') {
    log('non-Windows: please install tesseract via package manager (apt/brew) and ensure `tesseract` in PATH')
    return
  }
  ensureDir(binTessDir)
  ensureDir(vendorDir)

  // 1) vendor offline
  if (existsSync(VENDOR_ZIP) || existsSync(VENDOR_EXE)) {
    if (tryVendorCopy() && existsSync(binTessExe)) {
      await downloadTessdata()
      log('installed from vendor to ' + binTessExe)
      return
    }
  }

  // 2) download installer
  const tmpExe = join(os.tmpdir(), 'tesseract-ocr-w64-setup.exe')
  try {
    await download(TESSERACT_URL, tmpExe)
  } catch (e) {
    console.warn('[install-tesseract] download failed (offline?): ' + e.message)
    console.warn('  Offline: put installer or zip in vendor/tesseract/ and re-run')
    console.warn('  URL: ' + TESSERACT_URL)
    console.warn('  continuing without tesseract — image OCR will be unavailable')
    return
  }
  // Zone.Identifier 제거 (다운로드 파일 실행 차단 방지) — Default Project 경로 공백도 함께 처리
  try {
    execFileSync('powershell', ['-NoProfile', '-Command', `Unblock-File -LiteralPath '${tmpExe.replace(/'/g, "''")}'`], { stdio: 'inherit' })
  } catch {}
  log('running installer silently to ' + binTessDir)
  try {
    // 경로에 공백이 있어 /DIR="..." 로 따옴표 필수, PowerShell 경유 실행이 공백 처리에 안전
    const psCmd = `& '${tmpExe.replace(/'/g, "''")}' /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- /DIR="${binTessDir.replace(/"/g, '""')}"`
    execFileSync('powershell', ['-NoProfile', '-Command', psCmd], { stdio: 'inherit' })
  } catch (e) {
    console.warn('[install-tesseract] installer failed: ' + e.message + ' — continuing without tesseract')
    console.warn('  수동 설치: ' + tmpExe + ' 를 관리자 권한으로 실행해 ' + binTessDir + ' 에 설치하거나, vendor/tesseract 에 넣어 재실행')
    return
  }
  if (!existsSync(binTessExe)) {
    console.warn('[install-tesseract] installer finished but not found: ' + binTessExe + ' — continuing without tesseract')
    return
  }
  await downloadTessdata()
  log('installed to ' + binTessExe)
}

main().catch(e => { console.error('[install-tesseract] failed:', e); process.exit(0) })
