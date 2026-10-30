import { describe, expect, test } from 'vitest'
import { anchorKey, assignObjectKeys, describeDrawingKind, diffObjects } from '../src/lib/xlsxObjects'

describe('xlsxObjects describeDrawingKind', () => {
  test('image/chart pass through, unsupported gets description suffix', () => {
    expect(describeDrawingKind({ kind: 'image' })).toBe('image')
    expect(describeDrawingKind({ kind: 'chart' })).toBe('chart')
    expect(describeDrawingKind({ kind: 'unsupported', description: 'object' })).toBe('unsupported:object')
    expect(describeDrawingKind({ kind: 'unsupported', description: 'shape' })).toBe('unsupported:shape')
    expect(describeDrawingKind({ kind: 'unsupported' })).toBe('unsupported:object')
    expect(describeDrawingKind(null)).toBe('unknown')
  })

  test('anchorKey is stable for equal anchors', () => {
    expect(anchorKey({ from: { row: 1, col: 2 } })).toBe(anchorKey({ from: { row: 1, col: 2 } }))
    expect(anchorKey({ from: { row: 1, col: 2 } })).not.toBe(anchorKey({ from: { row: 1, col: 3 } }))
  })
})

describe('xlsxObjects assignObjectKeys', () => {
  const byKey = (ents: Array<{ key: string; sheet: number; kind: string; deleted?: boolean }>) =>
    new Map(ents.map((e) => [e.key, { sheet: e.sheet, kind: e.kind, deleted: e.deleted ?? false }]))
  test('matches per sheet+kind in order', () => {
    const order = { '0': ['o1', 'o2'], '1': ['o3'] }
    const m = assignObjectKeys(
      order,
      byKey([
        { key: 'o1', sheet: 0, kind: 'image' },
        { key: 'o2', sheet: 0, kind: 'unsupported:shape' },
        { key: 'o3', sheet: 1, kind: 'chart' },
      ]),
      [
        { sheet: 0, kind: 'image' },
        { sheet: 0, kind: 'unsupported:shape' },
        { sheet: 1, kind: 'chart' },
      ],
    )
    expect(m && [...m.entries()]).toEqual([
      [0, 'o1'],
      [1, 'o2'],
      [2, 'o3'],
    ])
  })
  test('deleted entries are skipped', () => {
    const order = { '0': ['o1', 'o2'] }
    const m = assignObjectKeys(
      order,
      byKey([
        { key: 'o1', sheet: 0, kind: 'image', deleted: true },
        { key: 'o2', sheet: 0, kind: 'image' },
      ]),
      [{ sheet: 0, kind: 'image' }],
    )
    expect(m && [...m.entries()]).toEqual([[0, 'o2']])
  })
  test('count mismatch returns null', () => {
    const order = { '0': ['o1', 'o2'] }
    const m = assignObjectKeys(
      order,
      byKey([
        { key: 'o1', sheet: 0, kind: 'image' },
        { key: 'o2', sheet: 0, kind: 'image' },
      ]),
      [{ sheet: 0, kind: 'image' }],
    )
    expect(m).toBeNull()
  })
  test('kind mismatch returns null', () => {
    const order = { '0': ['o1'] }
    const m = assignObjectKeys(order, byKey([{ key: 'o1', sheet: 0, kind: 'chart' }]), [{ sheet: 0, kind: 'image' }])
    expect(m).toBeNull()
  })
})

describe('xlsxObjects diffObjects', () => {
  const keyOf = (keys: Array<string | null>) => (i: number) => keys[i] ?? null

  test('no changes -> no ops', () => {
    const last = new Map([['o1', { anchor: anchorKey({ from: { row: 1 } }), deleted: false }]])
    const out = diffObjects([{ anchor: { from: { row: 1 } } }], last, keyOf(['o1']))
    expect(out).toEqual([])
  })

  test('moved anchor -> one move', () => {
    const last = new Map([['o1', { anchor: anchorKey({ from: { row: 1 } }), deleted: false }]])
    const out = diffObjects([{ anchor: { from: { row: 9 } } }], last, keyOf(['o1']))
    expect(out).toEqual([{ key: 'o1', type: 'move', anchor: { from: { row: 9 } } }])
  })

  test('missing key -> delete; unknown index without key is ignored', () => {
    const last = new Map([
      ['o1', { anchor: anchorKey({ from: { row: 1 } }), deleted: false }],
      ['o2', { anchor: anchorKey({ from: { row: 2 } }), deleted: false }],
    ])
    const out = diffObjects([{ anchor: { from: { row: 1 } } }, { anchor: { from: { row: 9 } } }], last, keyOf(['o1', null]))
    expect(out).toEqual([{ key: 'o2', type: 'delete' }])
  })

  test('seen set collects found keys across sheets', () => {
    const seen = new Set<string>()
    const last = new Map<string, { anchor: string; deleted: boolean }>()
    const out = diffObjects([{ anchor: { from: { row: 1 } } }], last, keyOf(['o1']), seen)
    expect(out).toEqual([{ key: 'o1', type: 'move', anchor: { from: { row: 1 } } }])
    expect([...seen]).toEqual(['o1'])
  })
})
