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
 * D1 red (pre-fix): 파트 저장으로 부모 lastHash가 adopt됐는데 타이핑 중인 부모는
 * 옛 파트를 든 바이트를 들고 있다. 이 저장이 409면 타이핑이 계속 실패하고(가),
 * 재시도가 통과하면 옛 파트가 디스크를 덮는다(나, 조용한 유실). 올바른 동작은
 * 서버가 디스크의 adopt 파트를 들어온 부모 zip에 다시 끼워 쓰는 것이다.
 * 시나리오: A가 부모를 연속 입력하는 동안 B가 첨부 저장 2회.
 * 단언: ① A 저장에 409나 사본 토스트 0회 ② 최종 디스크에 A의 입력과 B의 첨부
 * 마커가 모두 있음 ③ 입력 중 리셋 0회, 입력이 멈춘 뒤 리셋 1회.
 * D2 red (pre-fix): 미뤄진 방이 TTL을 기다리면, 그 안 재입장이 strict를 통과해
 * 옛 Y 상태를 받고, 자동저장이 디스크의 새 첨부를 덮는다. 마지막 퇴장 때 즉시
 * dispose되어야 한다.
 *
 * 타이밍 원칙: 5초 조용한 구간 안에 Y 활동이 끊기면 서버가 정상 리셋하므로,
 * B의 느린 UI 조작 동안에는 keepalive가 A 편집을 유지한다. keepalive와 라운드
 * 편집은 겹치지 않게 순차 실행한다 (같은 편집기라 동시 입력은 깨진다).
 * 저장은 디스크 반영으로만 단언한다 (pptx 저장은 lib/워커 경로라 페이지
 * 리스너에 안 잡힌다).
 */

const FIX = 'e2e/collab/fixtures/ole'
const PARENT_FIX: Record<string, string> = {
  pptx: 'e2e/collab/fixtures/collab-3slides.pptx',
  // xlsx/docx 호스트는 embed 조립이 되는 파일이어야 한다 (c5-2 proven).
  // collab-features.*는 drawing 구조상 조립 불가 (bad_host).
  xlsx: 'e2e/collab/fixtures/ole/embed-pdf.xlsx',
  docx: 'e2e/collab/fixtures/ole/embed-pdf.docx',
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
  sessionPosts: () => number
  /** B 탭이 보낸 저장 PUT 바이트들 (b 마크 포함 여부 판정용). */
  bPutBodies: Buffer[]
  /** pptx 공용 ShapeLocator (Body 2의 element id를 1회 확정 후 재사용). */
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
  if (!ins.ok) console.log(`[c6d] embed failed for ${parentPath}: ${JSON.stringify(ins).slice(0, 300)}`)
  expect(ins.ok).toBe(true)
  const part = (ins.embeddings ?? [])[0]!
  const got = (await fetch(
    `${backendBase()}/api/collab/embed?${new URLSearchParams({ path: parentPath, part }).toString()}`,
  ).then((r) => r.json())) as { ok?: boolean; data?: string }
  expect(got.ok).toBe(true)
  const partHash = createHash('sha256').update(Buffer.from(got.data!, 'base64')).digest('hex')
  return { part, partHash }
}

/** 부모를 열고 첨부 탭을 띄운다 + A 세션 증명 저장. */
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
    await expect.poll(() => shapes!.idFor('Body 2').then((id) => id.length, () => -1), { timeout: 60000, intervals: [1000] }).toBeGreaterThan(0)
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
  return { ctxA, ctxB, pageA, attach, parentPath, abs, part, sessionPosts: () => sessions, bPutBodies, shapes }
}

/** 서버 rooms API에서 부모 방이 보이는가 (리셋되면 dispose되어 안 보인다). */
async function parentRoomVisible(parentRel: string): Promise<boolean> {
  try {
    const res = await fetch(`${backendBase()}/api/collab/rooms`)
    const body = (await res.json()) as {
      rooms?: Array<{ rel?: string; part?: string }>
    }
    const rooms = body.rooms ?? []
    return rooms.some((r) => (r.rel ?? '').endsWith(parentRel) && !r.part)
  } catch {
    return true
  }
}

  /** U-http proven: 파트 xlsx 바이트의 공유 문자열에 마커를 추가한다. */
async function tamperPartXlsxBytes(partBytes: Uint8Array, marker: string): Promise<Buffer> {
  const inner = await JSZip.loadAsync(partBytes)
  const sn = 'xl/sharedStrings.xml'
  const f = inner.file(sn)
  if (!f) throw new Error('no sharedStrings in part')
  let xml = await f.async('string')
  const m = /<t>([^<]*)<\/t>/.exec(xml)
  if (!m) throw new Error('no <t> in sharedStrings')
  xml = xml.slice(0, m.index) + `<t>${m[1]}${marker}</t>` + xml.slice(m.index + m[0].length)
  inner.file(sn, xml)
  return Buffer.from(await inner.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }))
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

async function parentDiskHas(kind: string, abs: string, marker: string, shape = 'Body 2'): Promise<boolean> {
  try {
    if (kind === 'pptx') return ((await readDeck(abs)).textOf(shape) ?? '').includes(marker)
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

/**
 * B의 느린 UI 조작 동안 A 편집을 유지한다. 라운드 편집과는 겹치지 않게
 * 순차 실행한다 (같은 편집기라 동시 입력은 깨진다). curSeed는 호출자가
 * 들고 있는 현재 텍스트이며, keepalive가 덧붙인 만큼 갱신해 돌려준다.
 */
async function keepTypingDuring(
  kind: string,
  pageA: Page,
  shapes: ShapeLocator | null,
  curSeed: string,
  stop: () => boolean,
  onCycle?: (n: number) => Promise<void>,
): Promise<string> {
  let seed = curSeed
  let n = 0
  for (;;) {
    if (stop()) break
    try {
      if (kind === 'pptx') {
        await editShapeText(pageA, shapes!, seed, `${seed}k`)
        seed = `${seed}k`
      } else if (kind === 'xlsx') {
        await setCell(pageA, 'B1', `k${Date.now().toString(36).slice(-4)}`)
      } else {
        const pm = pageA.locator('docx-editor [contenteditable="true"]').first()
        await pm.click({ timeout: 8000 })
        await pageA.keyboard.type('k')
      }
      n += 1
      if (onCycle) await onCycle(n).catch(() => {})
    } catch {
      /* 다음 기회에 (텍스트 불변이라 시드 유효) */
    }
    await pageA.waitForTimeout(1500).catch(() => {})
    if (stop()) break
  }
  return seed
}

/**
 * 재입장 후: 실제 텍스트를 읽어 seed로 쓴다 (자동저장 여부에 따라 내용이 다르다).
 * editShapeText의 포커스/대기 로직을 그대로 쓰되 seed만 동적으로 구한다.
 * D3 전용 (rejoin 뒤 구 텍스트를 모를 때).
 */
async function typeAfterRejoin(page: Page, shapes: ShapeLocator, marker: string): Promise<void> {
  const curText = await page.evaluate(() => {
    const els = [...document.querySelectorAll('[data-element-id]')] as HTMLElement[]
    const el = els.find((e) => (e.textContent || '').trim().length > 1)
    return el ? (el.textContent ?? null) : null
  })
  if (!curText) throw new Error('no editable text found after rejoin')
  await editShapeText(page, shapes, curText, marker)
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
      try {
        // A의 현재 텍스트 (keepalive가 덧붙이면 함께 갱신).
        let cur = kind === 'pptx' ? `${slug}-ready` : ''
        // 2라운드. 라운드마다: A 입력 → B 첨부 저장 → 배너(adopt 증명).
        // B의 느린 조작 동안은 keepalive가 A 활동을 유지한다 (조용한 구간
        // 리셋 방지). keepalive 2주기마다 저장도 눌러 adopt 뒤 응답을 받는다.
        for (let n = 1; n <= 2; n += 1) {
          if (kind === 'pptx') {
            await editShapeText(t.pageA, t.shapes!, cur || 'Body 2', `${slug}-a${n}`)
            cur = `${slug}-a${n}`
          } else if (kind === 'xlsx') {
            await setCell(t.pageA, 'A1', `${slug}-a${n}`)
          } else {
            await typeDocx(t.pageA, `${slug}-a${n}`)
          }
          let bannerOn = false
          const bPhase = (async () => {
            await setCell(t.attach, `A${n}`, `${slug}-b${n}`)
            // lib 모델 전파 대기: dirty는 수식 바 확정 즉시 서지만, 저장 직렬화에
            // 타려면 한 박자 늦춰야 한다 (바로 저장하면 b 없는 바이트가 먼저 간다).
            await t.pageA.waitForTimeout(3000)
            await t.attach.getByTestId('attach-save').click({ timeout: 20000 })
          })()
          // B 조작과 동시에 A keepalive + 2주기마다 저장 클릭.
          const keepP = keepTypingDuring(kind, t.pageA, t.shapes, cur, () => bannerOn, async (i) => {
            if (i % 2 === 0) await clickParentSave(t.pageA)
          }).then((s) => {
            cur = s
          })
          // adopt 증명: 배너가 켜지면 서버가 미뤄진 것이다.
          await expect(t.pageA.getByTestId(banner)).toBeVisible({ timeout: 60000 })
          bannerOn = true
          await keepP
          await bPhase
          console.log(`[c6d] round ${n} B-adopted (banner on)`)
        }
        // ① A 저장에 409나 사본 경로가 없어야 한다: 실패 토스트 0회.
        await expect(
          t.pageA.locator('[data-sonner-toast]').filter({ hasText: /실패|충돌|409|사본|외부/ }),
        ).toHaveCount(0)
        // ② 디스크에 양쪽이 다 있다 (A 자동저장+재시도가 B를 덮는 (나) 경로 금지).
        expect(await parentDiskHas(kind, t.abs, `${slug}-a2`)).toBe(true)
        expect(await partDiskHas(t.abs, t.part, `${slug}-b1`)).toBe(true)
        expect(await partDiskHas(t.abs, t.part, `${slug}-b2`)).toBe(true)
        // ③ 입력 중에는 세션 재생성이 없다 (리셋 0회).
        expect(t.sessionPosts()).toBe(1)
        // 입력을 멈추면 조용한 구간에 리셋 1회.
        if (kind === 'pptx') {
          // pptx는 4001 후 자동 재입장한다 (세션 1번만 다시 생긴다).
          await expect.poll(() => Promise.resolve(t.sessionPosts()), { timeout: 60000, intervals: [1000] }).toBe(2)
          await t.pageA.waitForTimeout(8000)
          expect(t.sessionPosts()).toBe(2)
        } else {
          // xlsx/docx는 리셋 후 자동 재입장하지 않는다 — 부모 방이 dispose되어
          // rooms에서 사라진 채로 남는다. 사라졌다가 다시 생기지 않아야 한다.
          const fileName = t.parentPath.split('/').pop()!
          await expect
            .poll(() => Promise.resolve(parentRoomVisible(fileName)), { timeout: 60000, intervals: [1000] })
            .toBe(false)
          await t.pageA.waitForTimeout(8000)
          expect(await parentRoomVisible(fileName)).toBe(false)
        }
        // 리셋 뒤에도 디스크 양쪽 보존.
        expect(await parentDiskHas(kind, t.abs, `${slug}-a2`)).toBe(true)
        expect(await partDiskHas(t.abs, t.part, `${slug}-b2`)).toBe(true)
      } finally {
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
      // A 입력. B의 파트 교체는 HTTP로 한다 (U-http 패턴 — lock→GET→PUT).
      // 자동저장이 수렴한 뒤에 PUT해야 base가 안정적이다 (수렴 전 PUT은
      // 자동저장과 경합해 stale이 난다 — 1회 재시도로도 복구한다).
      await editShapeText(t.pageA, t.shapes!, `${slug}-ready`, `${slug}-a1`)
      await expect
        .poll(() => Promise.resolve(parentDiskHas('pptx', t.abs, `${slug}-a1`)), { timeout: 60000, intervals: [1000] })
        .toBe(true)
      const token = `c6d-${Date.now().toString(36)}`
      const lock = (await fetch(`${backendBase()}/api/collab/embed/lock`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: t.parentPath, part: t.part, name: 'c6d-d2', token }),
      }).then((r) => r.json())) as { ok?: boolean; lockId?: string }
      expect(lock.ok).toBe(true)
      try {
        const got = (await fetch(
          `${backendBase()}/api/collab/embed?${new URLSearchParams({ path: t.parentPath, part: t.part }).toString()}`,
        ).then((r) => r.json())) as { ok?: boolean; data?: string; hash?: string }
        expect(got.ok).toBe(true)
        const partBytes = Buffer.from(got.data!, 'base64')
        const mod = await tamperPartXlsxBytes(new Uint8Array(partBytes), `${slug}-b1`)
        const partHashNow = createHash('sha256').update(partBytes).digest('hex')
        const doPut = async (baseHash: string) => {
          const fd = new FormData()
          fd.append('file', new Blob([new Uint8Array(mod)], { type: 'application/octet-stream' }), 'embed-docx.xlsx')
          fd.append('baseHash', baseHash)
          fd.append('partHash', partHashNow)
          fd.append('lockId', lock.lockId!)
          return (await fetch(
            `${backendBase()}/api/collab/embed?${new URLSearchParams({ path: t.parentPath, part: t.part }).toString()}`,
            { method: 'PUT', body: fd },
          ).then((r) => r.json())) as { ok?: boolean; newHash?: string; currentHash?: string; code?: string; hasPendingPartChange?: boolean }
        }
        let put = await doPut(got.hash!)
        if (!put.ok && put.currentHash) put = await doPut(put.currentHash)
        console.log(JSON.stringify(put)); expect(put.ok).toBe(true)
        // 미뤄짐 증명: PUT 응답이 미뤄진 변경을 알린다.
        expect(put.hasPendingPartChange).toBe(true)
      } finally {
        await fetch(`${backendBase()}/api/collab/embed/lock`, {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: t.parentPath, part: t.part, lockId: lock.lockId!, token }),
        }).catch(() => {})
      }
      await expect
        .poll(() => Promise.resolve(partDiskHas(t.abs, t.part, `${slug}-b1`)), { timeout: 30000, intervals: [1000] })
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
        // 슬라이드 3의 Body 3을 편집한다 ('Third' 시드 — 슬라이드 2 텍스트와 무관).
        // 재입장이 옛 Y 상태면 이 저장이 디스크의 새 첨부를 덮는다 (red).
        await gotoSlide(pageA2, 3)
        const shapes2 = new ShapeLocator(pageA2)
        await editShapeText(pageA2, shapes2, 'Body 3', `${slug}-a2`)
        await clickParentSave(pageA2)
        await expect
          .poll(() => Promise.resolve(parentDiskHas('pptx', t.abs, `${slug}-a2`, 'Body 3')), { timeout: 60000, intervals: [1000] })
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

  test('D3-pptx: stale epoch save across reset is rejected (no silent overwrite)', async ({
    browser,
  }, testInfo) => {
    testInfo.setTimeout(420000)
    const slug = 'c6dd3pptx'
    const t = await openDeferPair(browser, 'pptx', slug, PARENT_FIX['pptx']!)
    try {
      // A 입력 후 B의 파트 교체를 HTTP로 한다 (U-http 패턴 lock→GET→PUT).
      // 자동저장이 수렴한 뒤에 PUT해야 base가 안정적이다.
      await editShapeText(t.pageA, t.shapes!, `${slug}-ready`, `${slug}-a1`)
      await expect
        .poll(() => Promise.resolve(parentDiskHas('pptx', t.abs, `${slug}-a1`, 'Body 2')), { timeout: 60000, intervals: [1000] })
        .toBe(true)
      // 리셋 전 바이트 스냅샷 (옛 첨부).
      const staleBytes = fs.readFileSync(t.abs)
      const token = `c6d-${Date.now().toString(36)}`
      const lock = (await fetch(`${backendBase()}/api/collab/embed/lock`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: t.parentPath, part: t.part, name: 'c6d-d3', token }),
      }).then((r) => r.json())) as { ok?: boolean; lockId?: string }
      expect(lock.ok).toBe(true)
      try {
        const got = (await fetch(
          `${backendBase()}/api/collab/embed?${new URLSearchParams({ path: t.parentPath, part: t.part }).toString()}`,
        ).then((r) => r.json())) as { ok?: boolean; data?: string; hash?: string }
        expect(got.ok).toBe(true)
        const partBytes = Buffer.from(got.data!, 'base64')
        const mod = await tamperPartXlsxBytes(new Uint8Array(partBytes), `${slug}-b1`)
        const partHashNow = createHash('sha256').update(partBytes).digest('hex')
        const doPut = async (baseHash: string) => {
          const fd = new FormData()
          fd.append('file', new Blob([new Uint8Array(mod)], { type: 'application/octet-stream' }), 'embed-docx.xlsx')
          fd.append('baseHash', baseHash)
          fd.append('partHash', partHashNow)
          fd.append('lockId', lock.lockId!)
          return (await fetch(
            `${backendBase()}/api/collab/embed?${new URLSearchParams({ path: t.parentPath, part: t.part }).toString()}`,
            { method: 'PUT', body: fd },
          ).then((r) => r.json())) as { ok?: boolean; newHash?: string; currentHash?: string; code?: string; hasPendingPartChange?: boolean }
        }
        let put = await doPut(got.hash!)
        if (!put.ok && put.currentHash) put = await doPut(put.currentHash)
        expect(put.ok).toBe(true)
        // 미뤄졌는지 기록만 남긴다 (즉시 리셋이어도 epoch 게이트 검증은 유효).
        console.log(`[c6d] D3 B-save ok, deferred=${put.hasPendingPartChange === true}`)
      } finally {
        await fetch(`${backendBase()}/api/collab/embed/lock`, {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: t.parentPath, part: t.part, lockId: lock.lockId!, token }),
        }).catch(() => {})
      }
      // 리셋+재입장 증거: 세션이 다시 생긴다 (새 epoch).
      await expect.poll(() => Promise.resolve(t.sessionPosts()), { timeout: 60000, intervals: [1000] }).toBeGreaterThanOrEqual(2)
      // 유효한 owner clientId를 관측된 저장에서 읽는다.
    let observedClient: number | null = null
    let observe = true
    const observeSave = (req: { method(): string; url(): string; headers(): Record<string, string> }) => {
      try {
        if (!observe) return
        // POST /api/collab/save (PUT 아님 — 실제 전송은 POST).
        if (req.method() === 'POST' && req.url().includes('/api/collab/save')) {
          const v = Number(req.headers()['x-collab-client'])
          if (Number.isInteger(v)) observedClient = v
        }
      } catch { /* 무시 */ }
    }
    t.pageA.on('request', observeSave)
    try {
      // 재입장 후 실제 텍스트를 읽어 seed로 쓴다 (자동저장 여부에 따라 내용이 다르다).
      // 재입장은 슬라이드 1로 돌아갈 수 있으므로 먼저 마커가 있는 슬라이드로 이동한다.
      await gotoSlide(t.pageA, 2)
      await typeAfterRejoin(t.pageA, t.shapes!, `${slug}-a1q`)
      await clickParentSave(t.pageA)
      await expect
        .poll(() => Promise.resolve(observedClient), { timeout: 60000, intervals: [500] })
        .not.toBeNull()
      // 조용해질 때까지 기다린다 (진행 중 저장 없음).
      await t.pageA.waitForTimeout(6000)
    } finally {
      observe = false
      t.pageA.off('request', observeSave)
    }
      // 방 ID를 rooms API에서 찾는다.
      const roomsRes = (await fetch(`${backendBase()}/api/collab/rooms`).then((r) => r.json())) as {
        rooms?: Array<{ roomId?: string; rel?: string; part?: string }>
      }
      const fileName = t.parentPath.split('/').pop()!
      const roomEntry = (roomsRes.rooms ?? []).find((r) => (r.rel ?? '').endsWith(fileName) && !r.part)
      expect(roomEntry?.roomId).toBeTruthy()
      const diskHash = createHash('sha256').update(fs.readFileSync(t.abs)).digest('hex')
      // 리셋을 넘어온 옛 저장: base는 맞지만 epoch이 옛 것이다.
      const forged = await fetch(`${backendBase()}/api/collab/save`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'x-collab-room': roomEntry!.roomId!,
          'x-collab-client': String(observedClient),
          'x-collab-base-hash': diskHash,
          'x-collab-epoch': 'stale-test-epoch',
        },
        body: staleBytes,
      }).then((r) => r.json().then((b) => ({ status: r.status, body: b as { code?: unknown } })))
      console.log(`[c6d] D3 forged save response: status=${forged.status} code=${String(forged.body?.code)}`)
      // 200 덮개 금지: epoch이 다르면 409 stale_client이어야 한다.
      expect(forged.status).toBe(409)
      expect(forged.body?.code).toBe('stale_client')
      // 디스크 첨부는 그대로다.
      expect(await partDiskHas(t.abs, t.part, `${slug}-b1`)).toBe(true)
      // 복구 확인: 새 epoch으로는 저장이 된다 (무한 409 루프 없음).
      let saw200 = false
      const watchOk = (res: { url(): string; status(): number }) => {
        try {
          if (res.url().includes('/api/collab/save') && res.status() === 200) saw200 = true
        } catch { /* 무시 */ }
      }
      t.pageA.on('response', watchOk)
      try {
        await gotoSlide(t.pageA, 2)
        await typeAfterRejoin(t.pageA, t.shapes!, `${slug}-a1r`)
        await clickParentSave(t.pageA)
        await expect.poll(() => Promise.resolve(saw200), { timeout: 60000, intervals: [500] }).toBe(true)
      } finally {
        t.pageA.off('response', watchOk)
      }
    } finally {
      await t.ctxA.close().catch(() => {})
      await t.ctxB.close().catch(() => {})
    }
  })
})
