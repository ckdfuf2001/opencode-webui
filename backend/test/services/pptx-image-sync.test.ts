import { describe, it, expect, beforeAll } from 'vitest'
import path from 'node:path'
import fs from 'node:fs/promises'
import JSZip from 'jszip'
import * as Y from 'yjs'
import { ensurePptxImagesSyncable } from '../../../frontend/src/lib/pptxImageSync'

/**
 * 4-1 표를 재현하는 결정적 테스트.
 * 브라우저 없이 lib의 실제 로드→Y.Doc seed→joiner adopt 경로를 그대로 태운다.
 *
 * 근거(라이브러리 위치):
 *  - ooxml-core createImageUrl: blob: URL을 만드는 분기 (chunk-GAGSCAR3.mjs, createImageUrl)
 *  - writeSlidesToYDoc/readSlidesFromYDoc: pptx:slides 직렬화 (pptx/editor/render/collaboration-sync.mjs)
 *  - pptxImageSync.ensurePptxImagesSyncable: 그 생성기를 data: URL로 고정하는 앱 패치
 */
const FIXTURE = path.resolve(__dirname, '../../../e2e/collab/fixtures/collab-3slides.pptx')

interface ImageCensus {
  pictures: number
  data: number
  blob: number
  other: number
}

const factories = {
  createMap: () => new Y.Map(),
  createArray: () => new Y.Array(),
  createText: () => new Y.Text(),
}

async function census(fixtureBytes: Uint8Array): Promise<ImageCensus> {
  // lib 진입점들을 동적 import (테스트 로드 시점 순서 영향 제거).
  const core: typeof import('ooxml-core/pptx') = await import('ooxml-core/pptx')
  const sync: typeof import('ooxml-core/pptx/editor/render/collaboration-sync') = await import(
    'ooxml-core/pptx/editor/render/collaboration-sync'
  )
  const ab = fixtureBytes.buffer.slice(
    fixtureBytes.byteOffset,
    fixtureBytes.byteOffset + fixtureBytes.byteLength,
  ) as ArrayBuffer
  const handler = new core.PptxHandler()
  const parsed = await handler.load(ab, {})
  // lib의 loadContent와 동일하게 이미지 해석 결과를 슬라이드에 싣는다.
  for (const slide of parsed.slides) {
    for (const el of slide.elements) {
      if ((el.type === 'picture' || el.type === 'image') && el.imagePath) {
        el.imageData = await handler.getImageData(el.imagePath)
      }
    }
  }
  // seeder가 쓰는 경로와 동일하게 Y.Doc에 싣는다.
  const doc = new Y.Doc()
  sync.writeSlidesToYDoc(parsed.slides, doc, factories, 'LOCAL')
  // joiner adopt 경로.
  const back = sync.readSlidesFromYDoc(doc)
  const out: ImageCensus = { pictures: 0, data: 0, blob: 0, other: 0 }
  for (const slide of back) {
    for (const el of slide.elements) {
      if (el.type !== 'picture' && el.type !== 'image') continue
      out.pictures += 1
      const d = typeof el.imageData === 'string' ? el.imageData : ''
      if (d.startsWith('data:')) out.data += 1
      else if (d.startsWith('blob:')) out.blob += 1
      else out.other += 1
    }
  }
  return out
}

describe('pptx collaboration image sync (4-1 census)', () => {
  let fixture: Uint8Array

  beforeAll(async () => {
    fixture = new Uint8Array(await fs.readFile(FIXTURE))
  })

  it('fixture has at least one picture', async () => {
    const zip = await JSZip.loadAsync(fixture)
    const media = Object.keys(zip.files).filter((n) => n.startsWith('ppt/media/'))
    expect(media.length).toBeGreaterThan(0)
  })

  it('E16a: WITHOUT the app patch the Y.Doc carries blob: URLs (joiner renders imageless)', async () => {
    // NOTE: 이 케이스는 패치를 적용하지 않은 상태를 재현한다.
    // 같은 프로세스에서 패치 후 케이스와 비교하기 위해, 별도 핸들러를 직접 만든다.
    const core: typeof import('ooxml-core/pptx') = await import('ooxml-core/pptx')
    const runtimeProto = Object.getPrototypeOf(core.createDefaultPptxHandlerRuntime()) as Record<
      string,
      unknown
    >
    const original = runtimeProto.createImageUrl
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' })
    runtimeProto.createImageUrl = (() => URL.createObjectURL(blob)) as unknown as typeof original
    try {
      const c = await census(fixture)
      expect(c.pictures).toBeGreaterThan(0)
      expect(c.blob).toBe(c.pictures)
      expect(c.data).toBe(0)
    } finally {
      runtimeProto.createImageUrl = original
      URL.revokeObjectURL('')
    }
  })

  it('E16b: WITH the app patch the Y.Doc carries data: URLs (joiner renders images)', async () => {
    ensurePptxImagesSyncable()
    const c = await census(fixture)
    expect(c.pictures).toBeGreaterThan(0)
    expect(c.blob).toBe(0)
    expect(c.data).toBe(c.pictures)
  })
})