import { describe, expect, test } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  isBlockedXlsxEdit,
  XLSX_UNSYNCED_FORMAT_LABELS,
  XLSX_UNSYNCED_STRUCTURE_LABELS,
  XLSX_UNSYNCED_SHEETS_LABELS,
  XLSX_UNSYNCED_ANNOTATION_LABELS,
} from '../src/lib/xlsxCollabGuard'

/**
 * C3: 동시편집 중 방에 실리지 않는 편집을 막는다.
 * - kind annotations 전체 차단, format/structure/sheets는 unsynced 라벨만 차단.
 * - 라벨은 ooxml-core 내부 상수 그대로라, lib이 바뀌면 아래 dist grep 테스트가 깨진다.
 */
describe('xlsxCollabGuard', () => {
  test('annotations는 전부 막는다', () => {
    expect(isBlockedXlsxEdit('annotations', 'Move object')).toBe(true)
    expect(isBlockedXlsxEdit('annotations', 'Insert picture')).toBe(true)
    expect(isBlockedXlsxEdit('annotations', 'Delete comment')).toBe(true)
    expect(isBlockedXlsxEdit('annotations', 'Insert hyperlink')).toBe(true)
    expect(isBlockedXlsxEdit('annotations', '무엇이든')).toBe(true)
  })

  test('format 중 조건부 서식만 막는다', () => {
    for (const label of XLSX_UNSYNCED_FORMAT_LABELS) {
      expect(isBlockedXlsxEdit('format', label)).toBe(true)
    }
    expect(isBlockedXlsxEdit('format', 'Format cells')).toBe(false)
    expect(isBlockedXlsxEdit('format', 'Merge & Center')).toBe(false)
    expect(isBlockedXlsxEdit('format', 'Cell style Good')).toBe(false)
    expect(isBlockedXlsxEdit('format', 'Typing in A1')).toBe(false)
  })

  test('structure 중 테이블만 막는다', () => {
    for (const label of XLSX_UNSYNCED_STRUCTURE_LABELS) {
      expect(isBlockedXlsxEdit('structure', label)).toBe(true)
    }
    expect(isBlockedXlsxEdit('structure', 'Insert sheet')).toBe(false)
    expect(isBlockedXlsxEdit('structure', 'Move rows')).toBe(false)
  })

  test('sheets 중 보호만 막는다', () => {
    for (const label of XLSX_UNSYNCED_SHEETS_LABELS) {
      expect(isBlockedXlsxEdit('sheets', label)).toBe(true)
    }
    expect(isBlockedXlsxEdit('sheets', 'Rename sheet')).toBe(false)
    expect(isBlockedXlsxEdit('sheets', 'Duplicate sheet')).toBe(false)
  })

  test('cells/names/view/batch는 막지 않는다', () => {
    expect(isBlockedXlsxEdit('cells', 'Typing in A1')).toBe(false)
    expect(isBlockedXlsxEdit('cells', 'Paste')).toBe(false)
    expect(isBlockedXlsxEdit('names', 'Define name')).toBe(false)
    expect(isBlockedXlsxEdit('view', 'Freeze panes')).toBe(false)
    expect(isBlockedXlsxEdit('batch', 'Fill')).toBe(false)
  })

  test('undo/redo는 되돌리는 op 기준으로 막는다 (우회 방지)', () => {
    // 혼자 옮긴 이미지를 상대 참가 뒤 undo하면 방에 없는 변경이 부활한다. 막는다.
    expect(isBlockedXlsxEdit('undo', 'Move object')).toBe(true)
    expect(isBlockedXlsxEdit('redo', 'Insert picture')).toBe(true)
    expect(isBlockedXlsxEdit('undo', 'Delete comment')).toBe(true)
    expect(isBlockedXlsxEdit('undo', 'Conditional formatting')).toBe(true)
    expect(isBlockedXlsxEdit('undo', 'Create table')).toBe(true)
    expect(isBlockedXlsxEdit('undo', 'Protect sheet')).toBe(true)
    // 셀 편집 undo는 허용한다.
    expect(isBlockedXlsxEdit('undo', 'Typing in A1')).toBe(false)
    expect(isBlockedXlsxEdit('undo', 'Paste')).toBe(false)
    expect(isBlockedXlsxEdit('redo', 'Format cells')).toBe(false)
  })

  test('알 수 없는 kind/label은 막지 않는다 (fail-open)', () => {
    expect(isBlockedXlsxEdit('mystery', 'Something new')).toBe(false)
    expect(isBlockedXlsxEdit('', '')).toBe(false)
  })
})

describe('xlsxCollabGuard labels exist in ooxml-core dist', () => {
  // lib을 올리면 라벨이 바뀔 수 있다. 조용히 뚫리는 대신 여기서 깨진다.
  const dist = (() => {
    const root = path.resolve(__dirname, '..', '..', 'node_modules', '.pnpm')
    const dirs = fs.readdirSync(root).filter((d) => d.startsWith('ooxml-core@'))
    expect(dirs.length).toBeGreaterThan(0)
    // 단일 복사본 기준: ooxml-core dist/xlsx/index.mjs 하나만 본다.
    const cands = dirs
      .map((d) => path.join(root, d, 'node_modules', 'ooxml-core', 'dist', 'xlsx', 'index.mjs'))
      .filter((p) => fs.existsSync(p))
    expect(cands.length).toBe(1)
    return fs.readFileSync(cands[0]!, 'utf8')
  })()

  test('차단 라벨이 dist에 그대로 있다', () => {
    const labels = [...XLSX_UNSYNCED_FORMAT_LABELS, ...XLSX_UNSYNCED_STRUCTURE_LABELS, ...XLSX_UNSYNCED_SHEETS_LABELS, ...XLSX_UNSYNCED_ANNOTATION_LABELS]
    expect(labels.length).toBeGreaterThan(0)
    for (const label of labels) {
      expect(dist.includes(`"${label}"`), `missing label in dist: ${label}`).toBe(true)
    }
  })

  test('choke point(run2)가 dist에 있다', () => {
    expect(dist.includes('const run2 = (label2, kind')).toBe(true)
  })
})
