#!/usr/bin/env node
/**
 * 메모리 규칙 자동 검사 (D26~D36).
 *
 *   node scripts/check-memory-rules.mjs      (또는 pnpm check:memory)
 *
 * 문서를 읽지 않아도 회귀를 걸러내기 위한 게이트다.
 * 허용 목록은 scripts/memory-allowlist.json 한 곳에만 둔다.
 *
 * 규칙:
 *   D29  refetchInterval / setInterval 은 허용 목록 파일·값으로만 허용한다.
 *   D29  같은 query key의 폴링 주체는 Pollers.tsx 한 곳뿐이다 (poll: true).
 *   D20  setLocalState( 는 0개여야 한다 (setLocalStateField 만 사용).
 *   D30  path 기반 releaseCollabSession( 은 없어야 한다.
 *   D36  세션 EventSource 는 1곳이어야 한다 (4b-P0 적용 후 error).
 *   D28  스트림 출력 상한 상수는 1곳이어야 한다 (4b-2 적용 후 error).
 *
 * 종료 코드: 오류가 있으면 1, 없으면 0.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const SRC = path.join(ROOT, 'frontend', 'src')
const ALLOWLIST_PATH = path.join(__dirname, 'memory-allowlist.json')

const allow = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'))
const severity = allow.rules ?? {}

/** 주석을 공백으로 치환한다(줄 번호 보존). 문자열 안의 // 는 보존. */
function stripComments(src) {
  let out = ''
  let i = 0
  let quote = null
  let inBlock = false
  while (i < src.length) {
    const c = src[i]
    const c2 = src[i + 1]
    if (inBlock) {
      if (c === '*' && c2 === '/') { inBlock = false; out += '  '; i += 2; continue }
      out += c === '\n' ? '\n' : ' '
      i++
      continue
    }
    if (quote) {
      out += c
      if (c === '\\') { out += c2 ?? ''; i += 2; continue }
      if (c === quote) quote = null
      i++
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i++; continue }
    if (c === '/' && c2 === '*') { inBlock = true; out += '  '; i += 2; continue }
    if (c === '/' && c2 === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++ }
      continue
    }
    out += c
    i++
  }
  return out
}

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full)
  }
  return out
}

const files = walk(SRC).map((f) => ({
  abs: f,
  rel: path.relative(ROOT, f).split(path.sep).join('/'),
  lines: stripComments(fs.readFileSync(f, 'utf8')).split(/\r?\n/),
}))

const errors = []
const warnings = []
const notes = []

function report(list, sev, dno, msg) {
  list.push({ sev, dno, msg })
}

function findAll(pattern) {
  const hits = []
  for (const f of files) {
    f.lines.forEach((line, idx) => {
      const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g')
      let m
      while ((m = re.exec(line)) !== null) {
        hits.push({ file: f.rel, line: idx + 1, text: line, match: m })
        if (m.index === re.lastIndex) re.lastIndex++
      }
    })
  }
  return hits
}

/** 허용 목록 조회: 같은 파일 + value 정규식 일치 */
function allowed(list, file, value) {
  return (list ?? []).find((e) => e.file === file && new RegExp(e.value).test(value))
}

// ── 1) refetchInterval (D29) ───────────────────────────────────────────────
{
  const hits = findAll(/\brefetchInterval\s*:\s*([^,]*)/)
  let checked = 0
  for (const h of hits) {
    const value = h.match[1].trim()
    if (value === 'false') continue // "캐시만 읽는다"는 언제나 허용 (D29)
    checked++
    if (!allowed(allow.refetchInterval, h.file, value)) {
      report(errors, 'error', 'D29',
        `refetchInterval 허용 목록에 없음: ${h.file}:${h.line} — "${value}"\n` +
        `      → D29 위반: 같은 query key의 refetchInterval은 Pollers.tsx(단일 폴러)에서만 허용한다.\n` +
        `      → 허용 목록에 추가하려면 docs/decisions.md D29에 근거와 측정값을 적고 scripts/memory-allowlist.json에 entry를 추가한다.`)
    }
  }
  notes.push(`D29 refetchInterval 검사: ${checked}건(허용 목록 외) / 전체 ${hits.length}건`)
}

// ── 2) setInterval (D29/D35) ──────────────────────────────────────────────
{
  const hits = findAll(/\bsetInterval\s*\((.*)$/)
  let checked = 0
  for (const h of hits) {
    const value = h.match[1].trim()
    checked++
    if (!allowed(allow.setInterval, h.file, value)) {
      report(errors, 'error', 'D35',
        `setInterval 허용 목록에 없음: ${h.file}:${h.line} — "${value}"\n` +
        `      → D35 위반: 유휴 상태에서 도는 타이머는 새로 추가하지 않는다.\n` +
        `      → 허용 목록에 추가하려면 docs/decisions.md D29/D35에 근거와 측정값을 적고 scripts/memory-allowlist.json에 entry를 추가한다.`)
    }
  }
  notes.push(`D35 setInterval 검사: ${checked}건`)
}

// ── 3) setLocalState 금지 (D20 / C5) ───────────────────────────────────────
{
  const hits = findAll(/\bsetLocalState\s*\(/)
  for (const h of hits) {
    report(errors, 'error', 'D20',
      `setLocalState( 금지: ${h.file}:${h.line}\n` +
      `      → D20/C5 위반: 단일 출처를 유지하려면 setLocalStateField('app', ...) 만 쓴다.`)
  }
  notes.push(`D20 setLocalState 검사: ${hits.length}건(0이어야 함)`)
}

// ── 4) path 기반 release 금지 (D30) ───────────────────────────────────────
{
  const hits = findAll(/\breleaseCollabSession\s*\(/)
  for (const h of hits) {
    report(errors, 'error', 'D30',
      `releaseCollabSession( 금지: ${h.file}:${h.line}\n` +
      `      → D30 위반: 세션 해제는 acquire가 준 lease 토큰으로만 한다.`)
  }
  notes.push(`D30 releaseCollabSession 검사: ${hits.length}건(0이어야 함)`)
}

// ── 5) 단일 폴러 (D29) ────────────────────────────────────────────────────
{
  const cfg = allow.singlePoller
  if (cfg) {
    const hits = findAll(new RegExp(`\\b(?:${cfg.hooks.join('|')})\\s*\\([^)]*poll\\s*:\\s*true[^)]*\\)`, 'g'))
    for (const h of hits) {
      if (h.file !== cfg.file) {
        report(errors, 'error', 'D29',
          `폴링 주체가 여러 곳입니다: ${h.file}:${h.line} — "${h.text.trim()}"\n` +
          `      → D29 위반: poll: true는 ${cfg.file} 한 곳에서만 허용한다. 나머지는 캐시만 읽는다.`)
      }
    }
    notes.push(`D29 단일 폴러 검사: poll:true = ${hits.length}건 (${cfg.file}만 허용)`)
  }
}

// ── 6) 세션 EventSource 1개 (D36) ─────────────────────────────────────────
{
  const hits = findAll(/\bnew EventSource\s*\(/)
  const byFile = new Map()
  for (const h of hits) {
    if (!byFile.has(h.file)) byFile.set(h.file, [])
    byFile.get(h.file).push(h.line)
  }
  const sessionFiles = ['frontend/src/hooks/useOpenCode.ts']
  for (const f of sessionFiles) {
    const n = (byFile.get(f) ?? []).length
    if (n > 1) {
      report(warnings, 'warn', 'D36',
        `세션 EventSource가 ${f}에 ${n}곳 있습니다: ${(byFile.get(f) ?? []).join(', ')}\n` +
        `      → D36: 세션당 EventSource는 1개여야 한다. 4b-P0에서 공용 레지스트리로 합칠 것(전송용 + ephemeral).`)
    }
  }
  notes.push(`D36 EventSource 검사: ${[...byFile.entries()].map(([f, l]) => `${f} ${l.length}곳`).join(', ')}`)
}

// ── 7) 스트림 출력 상한 상수 위치 (D28) ───────────────────────────────────
{
  const hits = findAll(/\b(MAX_[A-Z0-9_]*KEEP|MAX_[A-Z0-9_]*CAP|STREAM_[A-Z0-9_]*CAP)\s*=/)
  for (const h of hits) {
    if (!allowed(allow.streamCapConstants, h.file, '.*')) {
      report(warnings, 'warn', 'D28',
        `스트림 출력 상한 상수가 ${h.file}:${h.line}에 있습니다 — "${h.text.trim()}"\n` +
        `      → D28: 상한 상수는 1곳에만 둔다(4b-2에서 frontend/src/lib/streamOutputCaps.ts로 분리).`)
    }
  }
  notes.push(`D28 상한 상수 검사: ${hits.length}건`)
}

// ── 출력 ───────────────────────────────────────────────────────────────────
const label = (s) => (s === 'error' ? '✖ 오류' : '▲ 경고')
console.log('메모리 규칙 검사 (D26~D36) — scripts/check-memory-rules.mjs\n')
for (const n of notes) console.log(`  · ${n}`)
if (errors.length || warnings.length) {
  console.log('')
  for (const e of errors) console.log(`${label(e.sev)} [${e.dno}] ${e.msg}\n`)
  for (const w of warnings) console.log(`${label(w.sev)} [${w.dno}] ${w.msg}\n`)
}
console.log(`결과: 오류 ${errors.length}, 경고 ${warnings.length}`)
if (errors.length) {
  console.log('')
  console.log('위 오류를 고치거나 docs/decisions.md에 근거를 적고 scripts/memory-allowlist.json을 갱신하라.')
  process.exit(1)
}
console.log('모든 규칙 통과.')
process.exit(0)
