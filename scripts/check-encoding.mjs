#!/usr/bin/env node
/**
 * M17/1절: 인코딩 게이트.
 *
 * PowerShell 의 Get-Content/Set-Content/Out-File 로 소스를 썼다가 한글(UTF-8)이
 * 깨진 사고가 2회 있었다(U+FFFD 로 치환 또는 CP949 재인코딩). 이 검사는
 * **변경된 파일**에서 다음을 찾아 EXIT=1 한다.
 *
 *   1) U+FFFD (replacement character) — 인코딩이 깨진 흔적
 *   2) UTF-8 BOM 혼입 — 도구 혼동 흔적
 *   3) 한글 자리에 연속된 '?' — CP949→ASCII 재인코딩 흔적
 *   4) 한자(CJK ideograph) 혼입 — 어휘 혼합(경고)
 *
 * 규칙: 파일 수정은 edit/write 도구로만 한다.
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TEXT_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.yml', '.yaml', '.css', '.html', '.patch'])

function gitFiles() {
  const out = new Set()
  const runs = [
    ['diff', '--name-only', 'origin/main...HEAD'],
    ['diff', '--name-only', '--cached'],
    ['diff', '--name-only', 'HEAD~1', 'HEAD'],
    ['diff', '--name-only', 'HEAD~3', 'HEAD'],
  ]
  for (const args of runs) {
    try {
      const text = execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
      for (const line of text.split('\n')) {
        const f = line.trim()
        if (f) out.add(f)
      }
    } catch {
      // git 실패(원격 없음 등)는 무시.
    }
  }
  // 미추적(새) 파일도 검사 대상.
  try {
    const text = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    for (const line of text.split('\n')) {
      const f = line.trim()
      if (f) out.add(f)
    }
  } catch {
    // 무시.
  }
  return [...out]
}

const errors = []
const warnings = []
let checked = 0

for (const rel of gitFiles()) {
  const abs = path.join(ROOT, rel)
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue
  if (!TEXT_EXT.has(path.extname(rel))) continue
  const buf = fs.readFileSync(abs)
  if (buf.length > 8 * 1024 * 1024) continue
  checked += 1
  const text = buf.toString('utf8')

  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    errors.push(`${rel}: UTF-8 BOM 혼입 (BOM 없이 저장할 것)`)
  }
  const bad = text.indexOf('\uFFFD')
  if (bad >= 0) {
    const line = text.slice(0, bad).split('\n').length
    errors.push(`${rel}:${line}: U+FFFD(깨진 문자) 발견 — 인코딩 손상`)
  }
  // 한글 자리에 연속 '?' (CP949→ASCII 재인코딩).
  // 주의: `??`(nullish coalescing) 연산자는 흔하므로 제외한다 —
  // 손상 흔적은 '?' 3개 이상이거나, '?' 2개가 한글/한글 문자와 인접할 때만 본다.
  const q = /\?{2,}/g
  let m
  while ((m = q.exec(text)) !== null) {
    const before = text[m.index - 1] ?? ''
    const after = text[m.index + m[0].length] ?? ''
    const hangulNear = /[가-힣ㄱ-ㅎㅏ-ㅣ·—–―]/.test(before + after)
    if (m[0].length >= 3 || hangulNear) {
      const line = text.slice(0, m.index).split('\n').length
      errors.push(`${rel}:${line}: 한글 위치의 연속 '?' (${m[0].length}개) — 인코딩 재인코딩 흔적`)
      break
    }
  }
  // 한자 혼입 (경고)
  const han = /[\u4E00-\u9FFF\u3400-\u4DBF]/g
  const hanHit = han.exec(text)
  if (hanHit) {
    const line = text.slice(0, hanHit.index).split('\n').length
    warnings.push(`${rel}:${line}: 한자 혼입 — "${hanHit[0]}" (어휘 혼합 확인)`)
  }
}

console.log('인코딩 검사 (M17/1절) — 변경 파일', checked, '개')
if (warnings.length) {
  console.log('')
  for (const w of warnings) console.log('▲ 경고', w)
}
if (errors.length) {
  console.log('')
  for (const e of errors) console.log('✖ 오류', e)
  console.log('')
  console.log('파일 수정은 edit/write 도구로만 하거나(한글 손상 방지), BOM 없이 UTF-8 로 저장한다.')
  process.exit(1)
}
console.log('인코딩 이상 없음.')
process.exit(0)
