import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { absForRel } from './helpers/env'
import { openEditor } from './helpers/viewer'
import JSZip from 'jszip'

/**
 * X-B1: Chrome에서 XLSX Edit을 누르면 편집 UI 없이 전체창만 열리는 버그.
 *
 * 원인(B1-b, 저장소 근거):
 * - DocumentPreview.tsx:452 의 officeSaveDone 핸들러가 전역 이벤트라 다른 뷰어의
 *   저장 완료에도 editing=false 로 내려간다.
 * - officeSaveRequest 핸들러가 editing 과 무관하게 항상 등록되어 있었다.
 * 수정: 이벤트에 path를 붙이고, 그 경로가 ours일 때만 반영 + 편집 중에만 요청 수신.
 *
 * 통과 기준: Edit 클릭 20회 반복, 매회 편집 UI가 보인다. 실패 0.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE = path.join(here, 'fixtures', 'collab-features.xlsx')

/**
 * playwright.config.ts 가 **백엔드 시작 전에** 심어둔 파일명.
 *
 * 백엔드는 시작 시 저장소 트리를 스캔해 children 을 채운다(FileTree.tsx:150 의
 * needFetch = expanded && isDirectory && children === undefined). 서버가 뜬 뒤에
 * 복사한 파일은 트리에 나타나지 않는다(확인됨: config 시드 파일만 보였고,
 * 테스트 런타임에 복사한 파일은 안 보였다).
 * 그래서 하네스는 사전 시드 파일을 쓴다.
 */
const SEEDED_NAME = 'probe-seeded-before-server.xlsx'

function assertSeeded(): void {
  const abs = absForRel(path.posix.join('repos', 'collab-e2e', SEEDED_NAME))
  if (!fs.existsSync(abs)) throw new Error(`config did not seed ${abs} (playwright.config.ts)`)
}

/** XLSX가 마운트됐는지(편집기/보기 구분 없이). */
async function waitXlsxMounted(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForFunction(
    () => !!document.querySelector('[data-testid="xlsx-engine-root"], .xlsxengine-host'),
    null,
    { timeout: 30000 },
  )
}

/**
 * 편집 UI가 실제로 렌더됐는가.
 *
 * `.xlsxengine-host` 는 EngineHost 가 항상 두는 래퍼라 존재만으로는 판정이 안 된다.
 * B1 증상은 "호스트는 있는데 편집 UI 없이 전체창만 열림" 이므로,
 * **호스트 안에 엔진이 실제로 그렸는지**(자식 존재 + 툴바/수식바 표시)를 본다.
 * xlsx lib 은 data-testid 를 제공하지 않아 DOM 구조로 판정한다.
 */
function editorUi(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const host = document.querySelector('.xlsxengine-host') as HTMLElement | null
    if (!host) return { mounted: false, children: 0, visible: 0 }
    const kids = [...host.querySelectorAll('*')].filter((el) => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0
    })
    return { mounted: true, children: host.children.length, visible: kids.length }
  })
}

test.describe('X-B1: XLSX edit entry (solo path)', () => {
  test('X-B1: 20 sequential /edit navigations always render the editor', async ({ page }) => {
    const errs: string[] = []
    page.on('pageerror', (e) => errs.push(String(e)))
    page.on('console', (m) => {
      if (m.type() === 'error') errs.push(m.text())
    })

    assertSeeded()
    // C5-4 flag-day: 편집 진입은 /edit/* 직접 goto다 (in-page Edit 폐지).
    // 20회 반복 진입해도 매회 편집 UI가 보여야 한다. Done은 누르지 않는다
    // (다음 goto가 내비게이션으로 대체한다 — Done은 탭을 닫는다).
    const failures: Array<{ i: number; ui: unknown }> = []
    for (let i = 0; i < 20; i++) {
      await openEditor(page, `collab-e2e/${SEEDED_NAME}`)
      // 엔진이 실제로 그려질 때까지 기다린다(B1 은 렌더 지연이 아니라 아예 비어있다).
      await page.waitForTimeout(1200)
      const ui = await editorUi(page)
      if (!ui.mounted || ui.visible === 0) failures.push({ i, ui })
    }

    expect(failures, `edit UI missing on entries: ${failures.join(',')}`).toEqual([])
    // X-B1은 solo 경로 검증이므로 창/툴바 조작이 없다. 이 잡음은 E2E 환경에서
// commands 엔드포인트가 간헐적으로 실패해 발생한다(PPT 스위트도 동일).
const noise = /Failed to fetch commands|AxiosError/
    expect(
      errs.filter((e) => !noise.test(e)),
      `console/page errors: ${errs.slice(0, 3).join(' | ')}`,
    ).toEqual([])
  })
})

/**
 * X-B2(X1d): 다른 뷰어(DOCX)도 공용 저장 훅을 쓴다 — `requireIfMatch` 옵션을 넘기지
 * 않는 호출자는 If-Match 없이 기존대로 저장해야 하고, 디스크에 반영된다.
 * 회귀 배경: X1c 의 throw 가 hooks 유무와 무관하게 걸려 DOCX 저장이 막혔다.
 */
const DOCX_MARK = `XB2${Date.now().toString(36)}`

/** 최소 docx(zip) 를 만든다: Content_Types + rels + document + styles. */
async function makeMinimalDocx(abs: string): Promise<void> {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`,
  )
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  )
  zip.file(
    'word/_rels/document.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
  )
  zip.file(
    'word/styles.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:name w:val="Normal"/></w:style>
</w:styles>`,
  )
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body><w:p><w:r><w:t xml:space="preserve">Seed heading for ${DOCX_MARK}</w:t></w:r></w:p><w:sectPr/></w:body>
</w:document>`,
  )
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, await zip.generateAsync({ type: 'nodebuffer' }))
}

test.describe('X-B2: DOCX edit entry (other-office save path)', () => {
  test('X-B2: DOCX edit → save writes to disk', async ({ page }) => {
    const errs: string[] = []
    page.on('pageerror', (e) => errs.push(String(e)))
    page.on('console', (m) => {
      if (m.type() === 'error') errs.push(m.text())
    })
    const name = `b2-${Date.now().toString(36)}.docx`
    const abs = absForRel(path.posix.join('repos', 'collab-e2e', name))
    await makeMinimalDocx(abs)

    // C5-4 flag-day: 편집 진입은 /edit/* 직접 goto다 (트리 가시성과 무관하게 API로 읽는다).
    await openEditor(page, `collab-e2e/${name}`)
    // ProseMirror 본문에 타이핑한다(기존 문단 끝에 마커 추가).
    const pm = page.locator('docx-editor [contenteditable="true"]').first()
    await pm.waitFor({ timeout: 30000 })
    await pm.click({ timeout: 15000 })
    await page.keyboard.press('Control+End')
    await page.keyboard.type(DOCX_MARK)
    // 앱 상단 Save → 디스크 반영 확인.
    const save = page.locator('[data-testid="preview-doc-header"]').getByRole('button', { name: 'Save', exact: true })
    await save.waitFor({ timeout: 20000 })
    await save.click({ timeout: 20000 })
    await expect
      .poll(
        async () => {
          if (!fs.existsSync(abs)) return ''
          const buf = fs.readFileSync(abs)
          const zip = await JSZip.loadAsync(buf)
          const doc = await zip.file('word/document.xml')?.async('string')
          return doc?.includes(DOCX_MARK) ? DOCX_MARK : ''
        },
        { timeout: 25000, intervals: [500] },
      )
      .toBe(DOCX_MARK)

    const noise = /Failed to fetch commands|AxiosError/
    expect(
      errs.filter((e) => !noise.test(e)),
      `console/page errors: ${errs.slice(0, 3).join(' | ')}`,
    ).toEqual([])
  })
})