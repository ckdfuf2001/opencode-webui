import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import { createHash } from 'node:crypto'
import { backendBase, absForRel, uniqueRelWithExt } from './helpers/env'
import { gotoApp, openEditor, gotoSlide, editShapeText, ShapeLocator } from './helpers/viewer'
import { readDeck } from './helpers/disk'
import { ADA, seedUser } from './helpers/users'

/**
 * C6c-d: 미뤄진 부모 리셋 동안의 부모 저장 병합 (D1) + 마지막 퇴장 즉시 dispose (D2).
 *
 * D1 red: 파트 저장으로 부모 lastHash가 adopt됐는데 타이핑 중인 부모는 옛 파트를
 * 든 바이트를 들고 있다. 이 저장이 409면 타이핑이 계속 실패하고(가), 재시도가
 * 통과하면 옛 파트가 디스크를 덮는다(나, 조용한 유실). 올바른 동작은 서버가
 * 디스크의 adopt 파트를 들어온 부모 zip에 다시 끼워 쓰는 것이다.
 * 시나리오: A가 부모를 연속 입력·저장(2라운드)하는 동안 B가 첨부 저장 2회.
 * 단언: ① A 저장 전부 200 + 실패 토스트 0 ② 디스크에 A 입력과 B 첨부 마커
 * 모두 존재 ③ 입력 중 세션 재생성 0회, 입력 멈춘 뒤 정확히 1회(리셋 1회).
 * D2 red: 미뤄진 방이 TTL을 기다리면 재입장이 옛 Y 상태를 받아 디스크 새 첨부를
 * 덮는다. 마지막 퇴장 때 즉시 dispose되어야 한다.
 */

const FIX = 'e2e/collab/fixtures/ole'
const PARENT_FIX: Record<string, string> = {
  pptx: 'e2e/collab/fixtures/collab-3slides.pptx',
  xlsx: 'e2e/collab/fixtures/collab-features.xlsx',
  docx: 'e2e/collab/fixtures/collab-features.docx',
}
const BANNER_TESTID: Record<string, string> = {
  pptx: 'collab-part-pending',
  xlsx: 'xlsx-part-pending',
  docx: 'docx-part-pending',
}

interface DeferCtx {
  ctxA: BrowserContext
  ctxB: BrowserContext
  pageA: Page
  attach: Page
  parentPath: string
  abs: string
  part: string
  saveStatuses: number[]
  sessionPosts: () => number
  /** B 탭이 보낸 저장 PUT 바이트들 (b 마크 포함 여부 판정용). */
  bPutBodies: Buffer[]
  /** pptx 공용 ShapeLocator (Body 2의 element id를 1회 확정 후 재사용 — 텍스트 변경에 무관). */
  shapes: ShapeLocator | null
}

async function embedPart(
  parentPath: string,
  kind: string,
  fileBytes: Buffer,
): Promise<{ part: string; partHash: string }> {
  const fd = new FormData()
  fd.append('path', parentPath)
  fd.append('file', new Blob([new Uint8Array(fileBytes)], { type: 'application/octet-stream' }), 'embed-docx.xlsx')
  if (kind === 'pptx') fd.append('slide', '2')
  if (kind === 'xlsx') fd.append('sheet', '0')
  const ins = (await fetch(`${backendBase()}/api/collab/embed`, { method: 'POST', body: fd }).then((r) =>
    r.json(),
  )) as { ok?: boolean; embeddings?: string[] }
  expect(ins.ok).toBe(true)
  const part = (ins.embeddings ?? [])[0]!
  const got = (await fetch(
    `${backendBase()}/api/collab/embed?${new URLSearchParams({ path: parentPath, part }).toString()}`,
  ).then((r) => r.json())) as { ok?: boolean; data?: string }
  expect(got.ok).toBe(true)
  const partHash = createHash('sha256').update(Buffer.from(got.data!, 'base64')).digest('hex')
  return { part, partHash }
}

/** 부모를 열고 첨부 탭을 띄운다. 저장은 전부 관찰한다 (차단하지 않음). */
async function openDeferPair(
  browser: Browser,
  kind: string,
  slug: string,
  parentFixture: string,
): Promise<DeferCtx> {
  const rel = uniqueRelWithExt('c6d', 0, kind === 'pptx' ? '.pptx' : kind === 'xlsx' ? '.xlsx' : '.docx')
  const abs = absForRel(rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.copyFileSync(parentFixture, abs)
  const parentPath = rel.replace(/^repos\//, '')
  const fileBytes = fs.readFileSync(path.resolve(FIX, 'embed-docx.xlsx'))
  const { part, partHash } = await embedPart(parentPath, kind, fileBytes)
  const ctxA = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await seedUser(ctxA, ADA)
  const ctxB = await browser.newContext({ viewport: { width: 1400, height: 900 } })
  await seedUser(ctxB, ADA)
  const pageA = await ctxA.newPage()
  await gotoApp(pageA)
  // NOTE: pptx 저장은 lib/워커 경로라 page response 리스너에 안 잡힌다.
  // 저장은 디스크 반영으로만 단언한다 (ground truth). 상태코드는 참고용 로그.
  const saveStatuses: number[] = []
  pageA.on('response', (res) => {
    try {
      if (res.url().includes('/api/collab/save')) void res.status().then((s) => saveStatuses.push(s)).catch(() => {})
    } catch { /* 무시 */ }
  })
  let sessions = 0
  pageA.on('request', (req) => {
    try {
      if (req.method() === 'POST' && req.url().includes('/api/collab/session')) sessions += 1
    } catch { /* 무시 */ }
  })
  await openEditor(pageA, parentPath)
  let shapes: ShapeLocator | null = null
  if (kind === 'pptx') {
    await gotoSlide(pageA, 2)
    shapes = new ShapeLocator(pageA)
    // element id를 1회 확정한다 (이후 텍스트가 바뀌어도 id로 찾는다).
    await expect.poll(() => shapes!.idFor('Body 2').then((id) => id.length, () => -1), { timeout: 60000, intervals: [1000] }).toBeGreaterThan(0)
    // 세션 증명 저장: A의 세션이 완전히 동작함(owner·저장 경로)을 확인한다.
    // B의 파트 저장은 부모 flush를 거치므로 이 증명 없이는 flush가 실패한다.
    await editShapeText(pageA, shapes, 'Body 2', `${slug}-ready`)
  } else if (kind === 'xlsx') {
    await pageA.locator('xlsx-editor [part~="formula-bar"] textarea').first().waitFor({ timeout: 60000 })
    await setCell(pageA, 'A1', `${slug}-ready`)
  } else {
    await pageA.locator('docx-editor').first().waitFor({ timeout: 60000 })
    await pageA.locator('docx-editor [contenteditable="true"]').first().waitFor({ timeout: 60000 })
    await typeDocx(pageA, `${slug}-ready`)
  }
  await clickParentSave(pageA)
  // 증명 저장: 디스크에 ready 마크가 찍히면 A 세션이 완전히 동작함.
  await expect
    .poll(() => Promise.resolve(parentDiskHas(kind, abs, `${slug}-ready`)), { timeout: 90000, intervals: [1000] })
    .toBe(true)
  console.log(`[c6d] proof save ok`)
  const attach = await ctxB.newPage()
  // B의 저장 PUT 바이트를 캡처한다 (b 마크 포함 여부 = B 편집이 저장에 탔는지).
  const bPutBodies: Buffer[] = []
  attach.on('request', (req) => {
    try {
      const u = req.url()
      if ((req.method() === 'PUT' || req.method() === 'POST') && u.includes('/api/collab/save')) {
        const data = req.postDataBuffer()
        if (data) bPutBodies.push(data)
      }
    } catch { /* 무시 */ }
  })
  const origin = new URL(pageA.url()).origin
  const enc = (s: string): string => s.split('/').map((x) => encodeURIComponent(x)).join('/')
  await attach.goto(`${origin}/edit/${enc(parentPath)}/-/${enc(part)}?partHash=${partHash}&e2e=1&collabDebug=1`, {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  })
  await attach.getByTestId('edit-page').waitFor({ timeout: 30000 })
  await attach.locator('xlsx-editor [part~=formula-bar] textarea').first().waitFor({ timeout: 60000 })
  return { ctxA, ctxB, pageA, attach, parentPath, abs, part, saveStatuses, sessionPosts: () => sessions, bPutBodies, shapes }
}

/** 수식 바에 값을 넣어 셀을 편집한다 (c5-4 proven pattern). */
async function setCell(page: Page, ref: string, value: string): Promise<void> {
  await page.evaluate((r) => {
    const el = document.querySelector('xlsx-editor') as unknown as { select?: (ref: string) => void; focusGrid?: () => void } | null
    el?.select?.(r)
    el?.focusGrid?.()
  }, ref)
  const bar = page.locator('xlsx-editor [part~="formula-bar"] textarea').last()
  await bar.waitFor({ timeout: 15000 })
  await bar.click({ timeout: 15000 })
  await bar.fill(value)
  await bar.press('Enter')
  await expect
    .poll(async () => page.evaluate(() => (document.querySelector('xlsx-editor') as unknown as { dirty?: boolean } | null)?.dirty === true), {
      timeout: 15000,
      intervals: [200],
    })
    .toBe(true)
}

async function typeDocx(page: Page, marker: string): Promise<void> {
  const pm = page.locator('docx-editor [contenteditable="true"]').first()
  await pm.click({ timeout: 15000 })
  await page.keyboard.press('Control+End')
  await page.keyboard.type(marker, { delay: 20 })
}

async function clickParentSave(page: Page): Promise<void> {
  // pptx는 리본 Save가 입증됨(U-flush-race) — role 기반 먼저, 없으면 헤더.
  const role = page.getByRole('button', { name: 'Save', exact: true })
  try {
    await role.first().click({ timeout: 8000 })
    return
  } catch { /* 헤더로 폴백 */ }
  const btn = page.locator('[data-testid="preview-doc-header"]').getByRole('button', { name: 'Save', exact: true })
  await btn.first().click({ timeout: 20000 })
}

async function parentDiskHas(kind: string, abs: string, marker: string): Promise<boolean> {
  try {
    if (kind === 'pptx') return ((await readDeck(abs)).textOf('Body 2') ?? '').includes(marker)
    const zip = await JSZip.loadAsync(fs.readFileSync(abs))
    const names = kind === 'xlsx' ? ['xl/sharedStrings.xml', 'xl/worksheets/sheet1.xml'] : ['word/document.xml']
    for (const n of names) {
      const f = zip.file(n)
      if (f && (await f.async('string')).includes(marker)) return true
    }
    // xlsx는 셀 값이 인라인일 수 있어 전부 훑는다.
    for (const n of Object.keys(zip.files)) {
      if (!n.endsWith('.xml') || zip.files[n]!.dir) continue
      if ((await zip.files[n]!.async('string')).includes(marker)) return true
    }
    return false
  } catch {
    return false
  }
}

async function partDiskHas(abs: string, part: string, marker: string): Promise<boolean> {
  try {
    const zip = await JSZip.loadAsync(fs.readFileSync(abs))
    const f = zip.file(part)
    if (!f) return false
    const inner = await JSZip.loadAsync(await f.async('uint8array'))
    for (const n of Object.keys(inner.files)) {
      if (!n.endsWith('.xml') || inner.files[n]!.dir) continue
      if ((await inner.files[n]!.async('string')).includes(marker)) return true
    }
    return false
  } catch {
    return false
  }
}

test.describe('C6c-d: 미뤄진 동안 부모 저장 병합', () => {
  for (const kind of ['pptx', 'xlsx', 'docx']) {
    test(`D1-${kind}: 연속 입력+저장 중 첨부 2회 저장 — 409 없이 양쪽 디스크 보존, 리셋 1회`, async ({
      browser,
    }, testInfo) => {
      testInfo.setTimeout(420000)
      const slug = `c6dd1${kind}`
      const t = await openDeferPair(browser, kind, slug, PARENT_FIX[kind]!)
      const banner = BANNER_TESTID[kind]!
      // 연속 입력 keepalive: 라운드 내내 A 편집기에 Y 활동을 유지한다 (조용한
      // 구간 리셋 방지). 라운드 편집과 같은 편집기를 쓰되, 뮤텍스로 직렬화한다.
      // - pptx: 같은 도형을 공유 ShapeLocator(id 캐시)로 dwell — 텍스트가 바뀌어도
      //   id로 찾으므로 시드 추적이 필요 없고, 키보드 스트림이 직렬화돼 마크가
      //   깨지지 않는다 (단언은 includes).
      // - xlsx: B1 스크래치 셀 (A1은 라운드 전용).
      // - docx: 같은 contenteditable에 'k' 추가 (직렬화돼 마크가 깨지지 않는다).
      let keepTyping = true
      let tail: Promise<void> = Promise.resolve()
      const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
        const run = tail.then(fn, fn)
        tail = run.then(
          () => undefined,
          () => undefined,
        )
        return run
      }
      let keepCount = 0
      let keepCycles = 0
      const shapeId = kind === 'pptx' ? await t.shapes!.idFor('Body 2') : ''
      const keepaliveLoop = (async () => {
        let miss = false
        while (keepTyping) {
          try {
            await exclusive(async () => {
              if (kind === 'pptx') {
                // 편집기가 닫혀 있으면 id로 다시 연다 (텍스트 검색 없음).
                const open = await t.pageA.evaluate(
                  () =>
                    document.querySelectorAll('textarea, [contenteditable="true"]').length,
                )
                if (open === 0) {
                  await t.pageA.evaluate((eid) => {
                    const el = document.querySelector(`[data-element-id="${CSS.escape(eid)}"]`)
                    el?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
                  }, shapeId)
                  await t.pageA
                    .waitForFunction(() => document.querySelectorAll('textarea, [contenteditable="true"]').length > 0, null, {
                      timeout: 2500,
                    })
                    .catch(() => {})
                  // 못 열었으면 바로 다음 기회에 재시도 (sleep 생략).
                  const reopened = await t.pageA
                    .evaluate(() => document.querySelectorAll('textarea, [contenteditable="true"]').length)
                    .catch(() => 0)
                  if (reopened === 0) {
                    miss = true
                    return
                  }
                }
                miss = false
                await t.pageA.keyboard.type('k')
              } else if (kind === 'xlsx') {
                await setCell(t.pageA, 'B1', `k${(keepCount += 1)}`)
                miss = false
              } else {
                const pm = t.pageA.locator('docx-editor [contenteditable="true"]').first()
                await pm.click({ timeout: 15000 })
                await t.pageA.keyboard.type('k')
                miss = false
              }
            })
          } catch {
            /* 다음 기회에 */
          }
          if (!miss) await t.pageA.waitForTimeout(1200).catch(() => {})
        }
      })()
      const aEdit = (mark: string): Promise<void> =>
        exclusive(async () => {
          if (kind === 'pptx') {
            // id 캐시가 있어 텍스트와 무관하게 같은 도형을 찾는다.
            await editShapeText(t.pageA, t.shapes!, 'Body 2', mark)
          } else if (kind === 'xlsx') {
            await setCell(t.pageA, 'A1', mark)
          } else {
            await typeDocx(t.pageA, mark)
          }
        })
      try {
        // 2라운드: A 입력 → B 첨부 저장 → 배너(adopt 증명) 확인.
        // 저장은 keepalive가 2주기마다 눌러준다 (adopt 뒤 응답에 미뤄짐이 실림).
        // B 저장은 A 저장 진행 중에 들어간다 (U-flush-race와 동일).
        for (let n = 1; n <= 2; n += 1) {
          await aEdit(`${slug}-a${n}`)
          // B는 라운드마다 다른 셀에 쓴다 (같은 셀을 쓰면 B가 직접 옛 마크를 지운다).
          await setCell(t.attach, `A${n}`, `${slug}-b${n}`)
          // lib 모델 전파 대기: dirty는 수식 바 확정 즉시 서지만, 저장 직렬화에
          // 타려면 한 박자 늦춰야 한다 (바로 저장하면 b 없는 바이트가 먼저 간다).
          // keepalive가 활동을 유지하므로 조용한 구간 리셋은 나지 않는다.
          await t.pageA.waitForTimeout(3000)
          await t.attach.getByTestId('attach-save').click({ timeout: 20000 })
          // adopt 증명은 배너로 확인한다 (디스크 순간값은 자동저장이 덮을 수 있어
          // 폴링 대상이 아니다 — 최종 디스크는 마지막에 단언).
          await expect(t.pageA.getByTestId(banner)).toBeVisible({ timeout: 45000 })
          console.log(`[c6d] round ${n} B-adopted (banner on)`)
        }
        // 수렴 대기: A의 마지막 편집들이 디스크에 닿는다.
        await expect
          .poll(() => Promise.resolve(parentDiskHas(kind, t.abs, `${slug}-a2`)), { timeout: 90000, intervals: [1000] })
          .toBe(true)
        // 미뤄짐 배너가 보인다 (서버가 hasPendingPartChange를 알림).
        await expect(t.pageA.getByTestId(banner)).toBeVisible({ timeout: 30000 })
        // ① A 저장에 409나 사본 경로가 없어야 한다: 실패 토스트 0회.
        // (상태코드는 lib/워커 경로라 페이지에서 안 보일 수 있어 토스트+디스크로 단언.)
        await expect(
          t.pageA.locator('[data-sonner-toast]').filter({ hasText: /실패|충돌|409|사본|외부/ }),
        ).toHaveCount(0)
        // ② 디스크에 양쪽이 다 있다 (A 자동저장+재시도가 B를 덮는 (나) 경로 금지).
        expect(await partDiskHas(t.abs, t.part, `${slug}-b1`)).toBe(true)
        expect(await partDiskHas(t.abs, t.part, `${slug}-b2`)).toBe(true)
        // ③ 입력 중에는 세션 재생성이 없다 (리셋 0회).
        // keepalive는 이 단언까지 유지한다 (수동 체크 중 리셋 방지).
        expect(t.sessionPosts()).toBe(1)
        // 입력을 멈추면 조용한 구간에 리셋 1회 (세션 1번만 다시 생긴다).
        keepTyping = false
        await keepaliveLoop
        await expect.poll(() => Promise.resolve(t.sessionPosts()), { timeout: 60000, intervals: [1000] }).toBe(2)
        await t.pageA.waitForTimeout(8000)
        expect(t.sessionPosts()).toBe(2)
        // 리셋 뒤에도 디스크 양쪽 보존.
        expect(await parentDiskHas(kind, t.abs, `${slug}-a2`)).toBe(true)
        expect(await partDiskHas(t.abs, t.part, `${slug}-b2`)).toBe(true)
      } finally {
        keepTyping = false
        await keepaliveLoop.catch(() => {})
        await t.ctxA.close().catch(() => {})
        await t.ctxB.close().catch(() => {})
      }
    })
  }

  test('D2-pptx: 미뤄진 방의 마지막 퇴장 → 10초 안 재입장에 새 첨부가 보이고 저장이 덮지 않는다', async ({
    browser,
  }, testInfo) => {
    testInfo.setTimeout(420000)
    const slug = 'c6dd2pptx'
    const t = await openDeferPair(browser, 'pptx', slug, PARENT_FIX['pptx']!)
    try {
      // A가 입력 중이어서 B 저장 때 리셋이 미뤄진다 (B 입력 후 A가 직전에 타이핑).
      // 공용 locator의 id 캐시를 쓴다 (ready 마크와 무관).
      // B 편집은 저장 전에 전파 대기한다 (b 없는 바이트 선행 방지).
      await setCell(t.attach, 'A1', `${slug}-b1`)
      await t.pageA.waitForTimeout(3000)
      await editShapeText(t.pageA, t.shapes!, 'Body 2', `${slug}-a1`)
      await t.attach.getByTestId('attach-save').click({ timeout: 20000 })
      await expect
        .poll(() => t.attach.locator('[data-sonner-toast]').filter({ hasText: '저장했습니다' }).count(), {
          timeout: 60000,
          intervals: [1000],
        })
        .toBeGreaterThanOrEqual(1)
      await expect
        .poll(() => Promise.resolve(partDiskHas(t.abs, t.part, `${slug}-b1`)), { timeout: 60000, intervals: [1000] })
        .toBe(true)
      // A가 마지막으로 나간다 (방에 남은 conn 0).
      await t.pageA.close()
      await t.ctxA.close().catch(() => {})
      // 10초 안에 다시 연다: 새 방이 디스크(새 첨부) 기준으로 선다.
      await new Promise((r) => setTimeout(r, 2000))
      const ctxA2 = await browser.newContext({ viewport: { width: 1400, height: 900 } })
      await seedUser(ctxA2, ADA)
      const pageA2 = await ctxA2.newPage()
      await gotoApp(pageA2)
      try {
        await openEditor(pageA2, t.parentPath)
        await gotoSlide(pageA2, 2)
        const shapes2 = new ShapeLocator(pageA2)
        // 재입장한 파일에는 a1 마크가 들어 있다 (시드 Hello가 아님).
        await editShapeText(pageA2, shapes2, `${slug}-a1`, `${slug}-a2`)
        await clickParentSave(pageA2)
        await expect
          .poll(() => Promise.resolve(parentDiskHas('pptx', t.abs, `${slug}-a2`)), { timeout: 60000, intervals: [1000] })
          .toBe(true)
        // 자동저장 뒤에도 디스크의 새 첨부가 유지된다 (옛 Y 덮개 금지).
        await pageA2.waitForTimeout(8000)
        expect(await partDiskHas(t.abs, t.part, `${slug}-b1`)).toBe(true)
      } finally {
        await ctxA2.close().catch(() => {})
      }
    } finally {
      await t.ctxB.close().catch(() => {})
    }
  })
})
