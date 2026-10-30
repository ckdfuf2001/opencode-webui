import { describe, expect, test } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import {
  decideObjectOp,
  hasEmbObject,
  isBlockedXlsxEdit,
  NO_OBJECT_GUARD,
  XLSX_UNSYNCED_FORMAT_LABELS,
  XLSX_UNSYNCED_STRUCTURE_LABELS,
  XLSX_UNSYNCED_SHEETS_LABELS,
  XLSX_UNSYNCED_ANNOTATION_LABELS,
  type ObjectGuardCtx,
} from '../src/lib/xlsxCollabGuard'

/**
 * C3: 동시편집 중 방에 실리지 않는 편집을 막는다.
 * - kind annotations 전체 차단, format/structure/sheets는 unsynced 라벨만 차단.
 * - 라벨은 ooxml-core 내부 상수 그대로라, lib이 바뀌면 아래 dist grep 테스트가 깨진다.
 * C4: Move/Delete object는 개체 표 + 락으로 판정한다 (서버가 최종 판정).
 * - undo/redo 로 되돌리는 경우도 같은 경로 (서버 enforce, 메아리·우회 방지).
 */
const PASS_CTX: ObjectGuardCtx = { ...NO_OBJECT_GUARD }

describe('xlsxCollabGuard', () => {
  test('annotations는 개체 이동·삭제 외 전부 막는다', () => {
    expect(isBlockedXlsxEdit('annotations', 'Move object', PASS_CTX)).toBe(false)
    expect(isBlockedXlsxEdit('annotations', 'Delete object', PASS_CTX)).toBe(false)
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
    // 개체 이동의 undo/redo는 그냥 이동이라 서버가 판정한다 (메아리 전파 경로).
    expect(isBlockedXlsxEdit('undo', 'Move object', PASS_CTX)).toBe(false)
    expect(isBlockedXlsxEdit('redo', 'Move object', PASS_CTX)).toBe(false)
    expect(isBlockedXlsxEdit('undo', 'Move object', { ...PASS_CTX, mismatch: true })).toBe(true)
    // C4: 삭제의 undo/redo는 막는다 (서버 부활 API 없이 되살리면 발산한다).
    expect(isBlockedXlsxEdit('undo', 'Delete object', PASS_CTX)).toBe(true)
    expect(isBlockedXlsxEdit('redo', 'Delete object', PASS_CTX)).toBe(true)
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

  test('개체 op: emb/mismatch/남의 락이면 막는다', () => {
    const base: ObjectGuardCtx = { ...NO_OBJECT_GUARD }
    expect(decideObjectOp('annotations', 'Move object', base)).toBe('pass')
    expect(decideObjectOp('undo', 'Move object', base)).toBe('pass')
    expect(decideObjectOp('annotations', 'Move object', { ...base, embLocked: true })).toBe('emb')
    expect(decideObjectOp('annotations', 'Delete object', { ...base, embLocked: true })).toBe('emb')
    expect(decideObjectOp('annotations', 'Move object', { ...base, mismatch: true })).toBe('mismatch')
    expect(
      decideObjectOp('annotations', 'Move object', { ...base, activeKey: 'o1', foreignKeys: new Set(['o1']) }),
    ).toBe('foreign')
    expect(
      decideObjectOp('annotations', 'Delete object', { ...base, activeKey: 'o2', foreignKeys: new Set(['o1']) }),
    ).toBe('pass')
    expect(isBlockedXlsxEdit('annotations', 'Move object', { ...base, embLocked: true })).toBe(true)
    expect(isBlockedXlsxEdit('annotations', 'Delete object', { ...base, mismatch: true })).toBe(true)
    expect(
      isBlockedXlsxEdit('annotations', 'Move object', { ...base, activeKey: 'o1', foreignKeys: new Set(['o1']) }),
    ).toBe(true)
    expect(isBlockedXlsxEdit('annotations', 'Move object', base)).toBe(false)
  })

  test('개체 op: 오프라인이면 서버 강제가 안 되니 전부 막는다', () => {
    const off: ObjectGuardCtx = { ...NO_OBJECT_GUARD, online: false }
    expect(decideObjectOp('annotations', 'Move object', off)).toBe('offline')
    expect(decideObjectOp('undo', 'Move object', off)).toBe('offline')
    expect(decideObjectOp('undo', 'Delete object', off)).toBe('offline')
    expect(isBlockedXlsxEdit('annotations', 'Move object', off)).toBe(true)
    expect(isBlockedXlsxEdit('annotations', 'Delete object', off)).toBe(true)
    expect(isBlockedXlsxEdit('undo', 'Move object', off)).toBe(true)
  })

  test('surgical oleObj가 있으면 EMB로 판정한다', () => {
    expect(hasEmbObject(undefined)).toBe(false)
    expect(hasEmbObject([])).toBe(false)
    expect(hasEmbObject([{ sourceXml: '<xdr:twoCellAnchor><xdr:oleObj spid="x"/>' }])).toBe(true)
    expect(hasEmbObject([{ sourceXml: '<xdr:pic><xdr:cNvPr id="1"/></xdr:pic>' }])).toBe(false)
  })

  test('알 수 없는 kind/label은 막지 않는다 (fail-open)', () => {
    expect(isBlockedXlsxEdit('mystery', 'Something new')).toBe(false)
    expect(isBlockedXlsxEdit('', '')).toBe(false)
  })
})

describe('xlsxCollabGuard labels exist in ooxml-core dist', () => {
  // lib을 올리면 라벨이 바뀔 수 있다. 조용히 뚫리는 대신 여기서 깨진다.
  // lockfile에 고정된 해시가 실제 설치본이다(오래된 해시 디렉터리는 잔재일 수 있다).
  const dist = (() => {
    const root = path.resolve(__dirname, '..', '..', 'node_modules', '.pnpm')
    const lock = fs.readFileSync(path.resolve(__dirname, '..', '..', 'pnpm-lock.yaml'), 'utf8')
    const hash = /ooxml-core@1\.8\.0:\r?\n\s+hash: (\w+)/.exec(lock)?.[1]
    expect(hash, 'pnpm-lock에 ooxml-core 패치 해시가 있어야 한다').toBeTruthy()
    const p = path.join(root, `ooxml-core@1.8.0_patch_hash=${hash}`, 'node_modules', 'ooxml-core', 'dist', 'xlsx', 'index.mjs')
    expect(fs.existsSync(p), `설치본이 있어야 한다: ${p}`).toBe(true)
    return fs.readFileSync(p, 'utf8')
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

  test('차단 라벨은 동기화되는 kind와 짝을 이루지 않는다 (lib 업그레이드 감시)', () => {
    // dist의 ctx.run(label식, kind, …) 호출에서 라벨별 kind를 수집한다.
    // 리터럴 "L", "K"와 삼항 꼬리 "L",\n"K"를 모두 잡는다.
    // 같은 라벨이 cells 같은 동기화 kind로도 쓰이면 여기서 깨진다.
    const kindsForLabel = (label: string): Set<string> => {
      const kinds = new Set<string>()
      const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      for (const m of dist.matchAll(new RegExp(`"${esc}"\\s*,\\s*"([a-z]+)"`, 'g'))) kinds.add(m[1])
      // 삼항 라벨("New comment" 등): "L" : … , "K"
      for (const m of dist.matchAll(new RegExp(`"${esc}"\\s*:[^;]{0,300}?,\\s*"([a-z]+)"`, 'g'))) kinds.add(m[1])
      return kinds
    }
    // clearRange는 라벨이 변수(CLEAR_LABELS[what])라 위에서 안 잡힌다. 별도로 고정한다.
    const VARIABLE_LABELS = new Set(['Clear comments', 'Clear hyperlinks'])
    const cases: Array<[readonly string[], string]> = [
      [XLSX_UNSYNCED_FORMAT_LABELS, 'format'],
      [XLSX_UNSYNCED_STRUCTURE_LABELS, 'structure'],
      [XLSX_UNSYNCED_SHEETS_LABELS, 'sheets'],
      [XLSX_UNSYNCED_ANNOTATION_LABELS, 'annotations'],
    ]
    for (const [labels, kind] of cases) {
      for (const label of labels) {
        if (VARIABLE_LABELS.has(label)) continue
        const kinds = kindsForLabel(label)
        expect(kinds.size, `"${label}": dist run 호출에서 kind를 찾지 못함`).toBeGreaterThan(0)
        for (const k of kinds) {
          expect(k, `"${label}" kind`).toBe(kind)
        }
      }
    }
    // clearRange kind 매핑: comments/hyperlinks → annotations (변수 라벨이라 직접 고정)
    expect(dist.includes('CLEAR_LABELS[what],'), 'clearRange 라벨이 변수여야 한다').toBe(true)
    expect(
      dist.includes('what === "formats" ? "format" : what === "contents" || what === "all" ? "cells" : "annotations"'),
      'clearRange kind 매핑이 바뀌면 안 된다',
    ).toBe(true)
  })
})
