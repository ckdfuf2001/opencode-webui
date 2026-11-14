import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import { createHash } from 'node:crypto'
import { backendBase, absForRel, uniqueRelWithExt } from './helpers/env'
import { gotoApp, openEditor, gotoSlide, editShapeText, ShapeLocator } from './helpers/viewer'
import { readDeck } from './helpers/disk'
import { ADA, GRACE, seedUser } from './helpers/users'

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
 * B의 파트 교체 (HTTP lock→GET→PUT→unlock). adopt+defer를 증명한다.
 */
async function putPartMarker(t: DeferCtx, slug: string, marker: string): Promise<void> {
  const token = `c6d-${Date.now().toString(36)}${Math.floor(Math.random() * 1000000)}`
  const lock = (await fetch(`${backendBase()}/api/collab/embed/lock`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: t.parentPath, part: t.part, name: `c6d-${slug}`, token }),
  }).then((r) => r.json())) as { ok?: boolean; lockId?: string }
  expect(lock.ok).toBe(true)
  try {
    const got = (await fetch(
      `${backendBase()}/api/collab/embed?${new URLSearchParams({ path: t.parentPath, part: t.part }).toString()}`,
    ).then((r) => r.json())) as { ok?: boolean; data?: string; hash?: string }
    expect(got.ok).toBe(true)
    const partBytes = Buffer.from(got.data!, 'base64')
    const mod = await tamperPartXlsxBytes(new Uint8Array(partBytes), marker)
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
    // 상한 대기 중에는 부모 자동저장과 경합해 stale/dirty가 날 수 있다.
    // currentHash가 없어도 base를 새로 읽어 1회 더 시도한다 (setup 내성).
    if (!put.ok) {
      console.log(`[c6d] putPartMarker retry after ${JSON.stringify({ code: (put as { code?: unknown }).code })}`)
      const got2 = (await fetch(
        `${backendBase()}/api/collab/embed?${new URLSearchParams({ path: t.parentPath, part: t.part }).toString()}`,
      ).then((r) => r.json())) as { ok?: boolean; data?: string; hash?: string }
      if (got2.ok) {
        const partBytes2 = Buffer.from(got2.data!, 'base64')
        const mod2 = await tamperPartXlsxBytes(new Uint8Array(partBytes2), marker)
        const partHashNow2 = createHash('sha256').update(partBytes2).digest('hex')
        const fd2 = new FormData()
        fd2.append('file', new Blob([new Uint8Array(mod2)], { type: 'application/octet-stream' }), 'embed-docx.xlsx')
        fd2.append('baseHash', got2.hash!)
        fd2.append('partHash', partHashNow2)
        fd2.append('lockId', lock.lockId!)
        put = (await fetch(
          `${backendBase()}/api/collab/embed?${new URLSearchParams({ path: t.parentPath, part: t.part }).toString()}`,
          { method: 'PUT', body: fd2 },
        ).then((r) => r.json())) as { ok?: boolean; newHash?: string; currentHash?: string; code?: string; hasPendingPartChange?: boolean }
      }
    }
    if (!put.ok) console.log(`[c6d] putPartMarker failed: ${JSON.stringify(put).slice(0, 300)}`)
    expect(put.ok).toBe(true)
    expect(put.hasPendingPartChange).toBe(true)
  } finally {
    await fetch(`${backendBase()}/api/collab/embed/lock`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: t.parentPath, part: t.part, lockId: lock.lockId!, token }),
    }).catch(() => {})
  }
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

/** 덧붙이기 (editShapeText는 전체 교체라 기존 마커가 지워진다 — 현재문+접미사로 교체). */
async function appendShapeText(page: Page, shapes: ShapeLocator, suffix: string): Promise<void> {
  const curText = await page.evaluate(() => {
    const els = [...document.querySelectorAll('[data-element-id]')] as HTMLElement[]
    const el = els.find((e) => (e.textContent || '').trim().length > 1)
    return el ? (el.textContent ?? null) : null
  })
  if (!curText) throw new Error('no editable text found for append')
  await editShapeText(page, shapes, curText, `${curText}${suffix}`)
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

  test('D5-pptx: 4001 뒤 stale 응답은 중복 불러오지 않는다 (guard)', async ({
    browser,
  }, testInfo) => {
    testInfo.setTimeout(420000)
    const slug = 'c6dd5pptx'
    const t = await openDeferPair(browser, 'pptx', slug, PARENT_FIX['pptx']!)
    try {
      // OFFICE_RESET_RELOAD 카운터 (in-page 리스너).
      await t.pageA.evaluate(() => {
        ;(window as unknown as Record<string, unknown>).__c6c_e_resetCount = 0
        window.addEventListener('officeResetReload', () => {
          const w = window as unknown as Record<string, unknown>
          w.__c6c_e_resetCount = ((w.__c6c_e_resetCount as number) ?? 0) + 1
        })
      })
      const resetCount = (): Promise<unknown> =>
        t.pageA.evaluate(() => (window as unknown as Record<string, unknown>).__c6c_e_resetCount ?? -1)
      // A 입력 후 B의 파트 교체 (adopt+defer; 미룸 증명).
      await editShapeText(t.pageA, t.shapes!, `${slug}-ready`, `${slug}-a1`)
      await expect
        .poll(() => Promise.resolve(parentDiskHas('pptx', t.abs, `${slug}-a1`, 'Body 2')), { timeout: 60000, intervals: [1000] })
        .toBe(true)
      const token = `c6d-${Date.now().toString(36)}`
      const lock = (await fetch(`${backendBase()}/api/collab/embed/lock`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: t.parentPath, part: t.part, name: 'c6d-d5', token }),
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
        expect(put.hasPendingPartChange).toBe(true)
      } finally {
        await fetch(`${backendBase()}/api/collab/embed/lock`, {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: t.parentPath, part: t.part, lockId: lock.lockId!, token }),
        }).catch(() => {})
      }
      // POST /save를 붙잡아 둔다 (수동 continue/unroute/abort/headerValue 금지 —
      // 교착·소실의 원인. 해제는 fulfill(확정 응답)과 플래그 통과로만 한다).
      // 리셋 전 저장을 붙잡아 두었다가 리셋 직후 stale 409로 답한다 (mock 아님 대신
      // 서버 stale_client와 동일한 바디). 가드는 중복 불러오기를 막아야 한다.
      let releaseSaves = false
      let heldSaves = 0
      const heldRoutes: { fulfill: (r: unknown) => Promise<void> }[] = []
      await t.pageA.route('**/api/collab/save', async (route) => {
        if (route.request().method() !== 'POST') {
          await route.continue().catch(() => {})
          return
        }
        if (releaseSaves) {
          await route.continue().catch(() => {})
          return
        }
        heldSaves += 1
        heldRoutes.push(route as unknown as { fulfill: (r: unknown) => Promise<void> })
      })
      try {
        await gotoSlide(t.pageA, 2)
        await typeAfterRejoin(t.pageA, t.shapes!, `${slug}-a1q`)
        await clickParentSave(t.pageA)
        await expect
          .poll(() => Promise.resolve(heldSaves), { timeout: 60000, intervals: [500] })
          .toBeGreaterThan(0)
        // 조용한 구간 → 리셋(4001). 재입장은 즉시 진행된다.
        await expect.poll(() => resetCount(), { timeout: 90000, intervals: [500] }).toBeGreaterThanOrEqual(1)
        console.log(`[c6d] D5 reset fired, fulfilling stale 409`)
        // 붙잡힌 저장은 전부 리셋 전 세대다 (재입장+자동저장이 돌기 전에 fulfill하므로
        // E2가 섞일 수 없다). 늦은 stale 응답을 직접 답한다.
        // pre-fix: 무조건 full reload → 2번째 dispatch. post-fix: 차단.
        // collab이 null이어도, 새 세션이어도 가드가 막는다 — 재입장 대기가 필요 없다.
        const respP = t.pageA
          .waitForResponse((res) => res.url().includes('/api/collab/save') && res.request().method() === 'POST', {
            timeout: 60000,
          })
          .catch(() => null)
        for (const r of heldRoutes.splice(0)) {
          await r
            .fulfill({
              status: 409,
              contentType: 'application/json',
              body: JSON.stringify({ error: 'Room was reset after your last sync - reload first', code: 'stale_client', currentHash: null }),
            })
            .catch(() => {})
        }
        const resp = await respP
        expect(resp, 'held save got stale response').toBeTruthy()
        expect(resp!.status()).toBe(409)
        expect(((await resp!.json()) as { code?: unknown }).code).toBe('stale_client')
        await t.pageA.waitForTimeout(2000)
        // 단언 1: 중복 불러오기 없음 (pre-fix면 2).
        expect(await resetCount()).toBe(1)
        console.log(`[c6d] D5 no double reload (count==1)`)
        // 단언 2: 재입장 수렴 (서버 기준 — 참가자 있음).
        await expect
          .poll(async () => {
            const roomsRes = (await fetch(`${backendBase()}/api/collab/rooms`).then((r) => r.json())) as {
              rooms?: Array<{ rel?: string; part?: string; participants?: unknown[] }>
            }
            const e = (roomsRes.rooms ?? []).find((x) => (x.rel ?? '').endsWith(t.parentPath.split('/').pop()!) && !x.part)
            return e && Array.isArray(e.participants) && e.participants.length > 0
          }, { timeout: 90000, intervals: [1000] })
          .toBe(true)
        // 단언 3: 새 세션 저장 200 (무한 409 루프 없음). 이후 저장은 통과시킨다.
        releaseSaves = true
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
        expect(await partDiskHas(t.abs, t.part, `${slug}-b1`)).toBe(true)
      } finally {
        await t.pageA.unrouteAll({ behavior: 'wait' }).catch(() => {})
      }
    } finally {
      await t.ctxA.close().catch(() => {})
      await t.ctxB.close().catch(() => {})
    }
  })

  test('D6-pptx: 상한 리셋 전 flush — 구조+미반영 시 사본 제안', async ({
    browser,
  }, testInfo) => {
    testInfo.setTimeout(420000)
    const slug = 'c6dd6pptx'
    const t = await openDeferPair(browser, 'pptx', slug, PARENT_FIX['pptx']!)
    try {
      await t.pageA.evaluate(() => {
        ;(window as unknown as Record<string, unknown>).__c6c_e_resetCount = 0
        window.addEventListener('officeResetReload', () => {
          const w = window as unknown as Record<string, unknown>
          w.__c6c_e_resetCount = ((w.__c6c_e_resetCount as number) ?? 0) + 1
        })
        // C6c-f item 2: 서버 103 flush 요청을 관측한다 (B2 즉시-ok면 저장이
        // 없어도 officeSaveRequest는 항상 나가므로, 저장 유무와 무관한 지문).
        // adopt 시점의 flush는 armed 전이라 무시된다 (아래에서 armed).
        ;(window as unknown as Record<string, unknown>).__c6c_f_flushSeen = false
        window.addEventListener('officeSaveRequest', (e) => {
          const d = (e as CustomEvent<{ flushRequestId?: unknown }>).detail
          if (d && typeof d.flushRequestId === 'string') {
            ;(window as unknown as Record<string, unknown>).__c6c_f_flushSeen = true
          }
        })
      })
      const resetCount = (): Promise<unknown> =>
        t.pageA.evaluate(() => (window as unknown as Record<string, unknown>).__c6c_e_resetCount ?? -1)
      const flushSeen = (): Promise<unknown> =>
        t.pageA.evaluate(() => (window as unknown as Record<string, unknown>).__c6c_f_flushSeen ?? false)
      // Phase A: 상한(deadline) 경로 구조. flush(103)는 officeSaveRequest의
      // flushRequestId로 관측한다 (B2 즉시-ok면 저장이 없어도 요청은 항상
      // 나가므로, 저장 유무와 무관한 지문). pre-fix는 flush 자체가 없어 빨강.
      // adopt 시점의 flush는 플래그를 리셋해 무시한다.
      await editShapeText(t.pageA, t.shapes!, `${slug}-ready`, `${slug}-a1`)
        await expect
          .poll(() => Promise.resolve(parentDiskHas('pptx', t.abs, `${slug}-a1`, 'Body 2')), { timeout: 60000, intervals: [1000] })
          .toBe(true)
        await putPartMarker(t, slug, `${slug}-b1`)
        const t0 = Date.now()
        await t.pageA.evaluate(() => {
          ;(window as unknown as Record<string, unknown>).__c6c_f_flushSeen = false
        })
        // 상한 직전(T0+56s)까지 계속 입력한다. flush 저장(103 직후 즉시 저장)이
        // 꼬리까지 포함하고, 상한(60s)이 조용한 리셋보다 먼저 오도록 한다.
        let cur = `${slug}-a1`
        let lastMarker = cur
        while (Date.now() - t0 < 56000) {
          const m = `${slug}-a1d${Date.now().toString(36).slice(-4)}`
          try {
            await editShapeText(t.pageA, t.shapes!, cur, m)
          } catch {
            break
          }
          cur = m
          lastMarker = m
          if (Number(await resetCount()) >= 1) break
        }
        console.log(`[c6d] D6 typing done, lastMarker=${lastMarker}`)
        // flush 시도 관측 (상한+여유 75s). pre-fix면 절대 안 온다.
        await expect.poll(() => flushSeen(), { timeout: 75000, intervals: [500] }).toBe(true)
        console.log(`[c6d] D6 flush attempted`)
        await expect.poll(() => resetCount(), { timeout: 30000, intervals: [500] }).toBeGreaterThanOrEqual(1)
        console.log(`[c6d] D6 reset fired`)
        // 재입장 수렴 후 디스크: 마지막 마커 + B 첨부.
        await expect
          .poll(async () => {
            const roomsRes = (await fetch(`${backendBase()}/api/collab/rooms`).then((r) => r.json())) as {
              rooms?: Array<{ rel?: string; part?: string; participants?: unknown[] }>
            }
            const e = (roomsRes.rooms ?? []).find((x) => (x.rel ?? '').endsWith(t.parentPath.split('/').pop()!) && !x.part)
            return e && Array.isArray(e.participants) && e.participants.length > 0
          }, { timeout: 90000, intervals: [1000] })
          .toBe(true)
        await expect
          .poll(() => Promise.resolve(parentDiskHas('pptx', t.abs, lastMarker, 'Body 2')), { timeout: 90000, intervals: [1000] })
          .toBe(true)
        expect(await partDiskHas(t.abs, t.part, `${slug}-b1`)).toBe(true)
        console.log(`[c6d] D6 phase A rescued markers on disk`)
      // Phase B: flush 실패(타임아웃)면 사본 제안. B-PUT 뒤에 저장을 30초
      // 붙잡아 미뤄진 리셋의 flush를 굶긴다 (B-PUT 자체의 adopt-flush가 먼저
      // 끝나야 하므로 홀드는 PUT 뒤에 건다).
      await gotoSlide(t.pageA, 2)
      await typeAfterRejoin(t.pageA, t.shapes!, `${slug}-mB`)
      await putPartMarker(t, slug, `${slug}-b2`)
      // 홀드 뒤에 한 번 더 입력해야 flush 시점에 미저장이 남는다 (B2 즉시-ok
      // 회피 — 미저장 없이 103이 오면 저장이 없어 타임아웃이 안 된다).
      let holdSaves = true
      await t.pageA.route('**/api/collab/save', async (route) => {
        if (route.request().method() !== 'POST' || !holdSaves) {
          await route.continue().catch(() => {})
          return
        }
        await new Promise((r) => setTimeout(r, 30000))
        await route.continue().catch(() => {})
      })
      await typeAfterRejoin(t.pageA, t.shapes!, `${slug}-mB2`)
      // 103 도달 확인 (flush 시도 자체 — pre-fix면 절대 안 온다).
      await t.pageA.evaluate(() => {
        ;(window as unknown as Record<string, unknown>).__c6c_f_flushSeen = false
      })
      await expect.poll(() => flushSeen(), { timeout: 30000, intervals: [500] }).toBe(true)
      console.log(`[c6d] D6 phase B flush attempted`)
      // 입력 중단 → 조용 5초 → flush(103, held) → 8초 타임아웃 → unflushed 리셋.
      // 배너는 재입장 뒤에도 유지되므로(keepStaleNotice) 먼저 단언하고,
      // 사본 링크는 별도로 단언한다 (getContent 완료 시점에 붙는다).
      await expect
        .poll(() => t.pageA.getByText('마지막 변경이 반영되지 않았을 수 있음').count(), { timeout: 60000, intervals: [500] })
        .toBeGreaterThan(0)
      console.log(`[c6d] D6 phase B stale banner shown`)
      await expect
        .poll(() => t.pageA.getByRole('link', { name: '내 사본 다운로드' }).count(), { timeout: 60000, intervals: [500] })
        .toBeGreaterThan(0)
      console.log(`[c6d] D6 phase B stale banner + download offered`)
      expect(await partDiskHas(t.abs, t.part, `${slug}-b2`)).toBe(true)
    } finally {
      await t.ctxA.close().catch(() => {})
      await t.ctxB.close().catch(() => {})
    }
  })

  test('D7-xlsx: 미룸 중 새로 들어온 peer에게 pending 배너 (C6N late join)', async ({
    browser,
  }, testInfo) => {
    testInfo.setTimeout(420000)
    const slug = 'c6dd7xlsx'
    const t = await openDeferPair(browser, 'xlsx', slug, PARENT_FIX['xlsx']!)
    let pageC: Page | null = null
    let ctxC: BrowserContext | null = null
    try {
      // A 입력 후 수렴 확인.
      await setCell(t.pageA, 'A1', `${slug}-a1`)
      await expect
        .poll(() => Promise.resolve(parentDiskHas('xlsx', t.abs, `${slug}-a1`, 'Sheet1')), { timeout: 60000, intervals: [1000] })
        .toBe(true)
      // A 계속 입력 (미룸 유지). B는 attach 탭에서 파트 저장 (xlsx proven 패턴).
      let cBannerOn = false
      const keepP = keepTypingDuring('xlsx', t.pageA, null, `${slug}-a1`, () => cBannerOn).catch(() => `${slug}-a1`)
      const bPhase = (async () => {
        await setCell(t.attach, 'A1', `${slug}-b1`)
        // lib 모델 전파 대기: 더티는 수식 바 확정 즉시 서지만, 저장 직렬화에는
        // 한 박자 늦춰야 한다 (바로 저장하면 b 없는 바이트가 먼저 간다).
        await t.pageA.waitForTimeout(3000)
        await t.attach.getByTestId('attach-save').click({ timeout: 20000 })
      })()
      try {
        // 미룸 증명: A에 배너가 켜진다.
        await expect(t.pageA.getByTestId('xlsx-part-pending')).toBeVisible({ timeout: 60000 })
        await bPhase
        console.log(`[c6d] D7 deferred (A banner on, keep typing for C)`)
        // C: 같은 파일을 새로 연다 (미룸 중 늦은 참가). 별도 컨텍스트 = 다른 참가자.
        // keepP는 C 배너가 뜰 때까지 계속 입력한다 (A가 멈추면 조용한 리셋이 먼저 난다).
        ctxC = await browser.newContext({ viewport: { width: 1400, height: 900 } })
        await seedUser(ctxC, ADA)
        pageC = await ctxC.newPage()
        // C 자신의 저장은 막는다: 배너는 105로만 와야 한다 (저장 응답 경로 차단).
        // pre-fix면 절대 안 뜨므로 red가 된다.
        await pageC.route('**/api/collab/save', async (route) => {
          if (route.request().method() !== 'POST') {
            await route.continue().catch(() => {})
            return
          }
          await route.abort('blockedbyclient').catch(() => {})
        })
        await gotoApp(pageC)
        await openEditor(pageC, t.parentPath)
        await pageC.locator('xlsx-editor [part~=formula-bar] textarea').first().waitFor({ timeout: 60000 }).catch(() => {})
        // C6N: 서버가 105를 보내므로 C에 미반영 배너가 뜬다 (pre-fix면 절대 안 뜸).
        await expect(pageC.getByTestId('xlsx-part-pending')).toBeVisible({ timeout: 30000 })
        cBannerOn = true
        console.log(`[c6d] D7 late joiner sees pending banner`)
      } finally {
        cBannerOn = true
        await keepP.catch(() => {})
      }
    } finally {
      await pageC?.close().catch(() => {})
      await ctxC?.close().catch(() => {})
      await t.ctxA.close().catch(() => {})
      await t.ctxB.close().catch(() => {})
    }
  })

  test('D8-pptx: 타이핑 중 첨부 삽입 → 5초 안에 양쪽 반영 (즉시 리셋)', async ({
    browser,
  }, testInfo) => {
    testInfo.setTimeout(420000)
    const slug = 'c6dd8pptx'
    const t = await openDeferPair(browser, 'pptx', slug, PARENT_FIX['pptx']!)
    // B: 같은 파일을 보는 두 번째 탭 (peer).
    const pageB = await t.ctxA.newPage()
    try {
      await gotoApp(pageB)
      await openEditor(pageB, t.parentPath)
      await pageB.locator('[data-testid="pptx-viewer-root"]').first().waitFor({ timeout: 60000 }).catch(() => {})
      // A: clientId 관측용 저장 1회.
      let observedClient: number | null = null
      const observeSave = (req: { method(): string; url(): string; headers(): Record<string, string> }) => {
        try {
          if (req.method() !== 'POST' || !req.url().includes('/api/collab/save')) return
          const v = Number(req.headers()['x-collab-client'])
          if (Number.isInteger(v)) observedClient = v
        } catch { /* 무시 */ }
      }
      t.pageA.on('request', observeSave)
      try {
        await gotoSlide(t.pageA, 2)
        await typeAfterRejoin(t.pageA, t.shapes!, `${slug}-aqq`)
        await clickParentSave(t.pageA)
        await expect.poll(() => Promise.resolve(observedClient), { timeout: 60000, intervals: [500] }).not.toBeNull()
      } finally {
        t.pageA.off('request', observeSave)
      }
      // A 계속 입력 + B는 대기.
      let stop = false
      const keepP = (async () => {
        try {
          let n = 0
          while (!stop) {
            n += 1
            await typeAfterRejoin(t.pageA, t.shapes!, `${slug}-aq${n}`)
            await t.pageA.waitForTimeout(1000).catch(() => {})
          }
        } catch { /* 리셋으로 편집 중단되면 종료 */ }
      })()
      const attachName = `c6d8-insert.docx`
      let attachBytes: Buffer
      try {
        attachBytes = fs.readFileSync(path.join(FIX, 'embed-docx.docx'))
      } catch {
        attachBytes = Buffer.from('c6d8-fallback-bytes')
      }
      const doPost = async (baseHash: string) => {
        const fd = new FormData()
        fd.append('path', t.parentPath)
        fd.append('file', new Blob([new Uint8Array(attachBytes)]), attachName)
        fd.append('clientId', String(observedClient))
        fd.append('baseHash', baseHash)
        return (await fetch(`${backendBase()}/api/collab/embed`, { method: 'POST', body: fd }).then((r) =>
          r.json(),
        )) as { ok?: boolean; code?: string; newHash?: string; currentHash?: string }
      }
      // 타이핑 중 삽입: 409면 따라잡고 재시도한다 (클라이언트와 동일, 최대 3회).
      let post = await doPost(createHash('sha256').update(fs.readFileSync(t.abs)).digest('hex'))
      for (let attempt = 0; !post.ok && post.code === 'dirty_room' && attempt < 2; attempt++) {
        await t.pageA.waitForTimeout(2000).catch(() => {})
        post = await doPost(createHash('sha256').update(fs.readFileSync(t.abs)).digest('hex'))
      }
      expect(post.ok).toBe(true)
      console.log(`[c6d] D8 insert ok`)
      stop = true
      await keepP.catch(() => {})
      // A와 B 양쪽에 5초 안에 첨부가 보인다 (즉시 리셋 — 미룸 없음).
      const t0 = Date.now()
      await expect(t.pageA.getByText(attachName).first()).toBeVisible({ timeout: 5000 })
      await expect(pageB.getByText(attachName).first()).toBeVisible({ timeout: 5000 })
      console.log(`[c6d] D8 both views show insert in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
    } finally {
      await pageB.close().catch(() => {})
      await t.ctxA.close().catch(() => {})
      await t.ctxB.close().catch(() => {})
    }
  })

  test('D9-pptx: 타이핑 중 삽입 → 리셋 없이 칩이 클릭 자리에 (백그라운드 병합)', async ({
    browser,
  }, testInfo) => {
    testInfo.setTimeout(420000)
    const slug = 'c6dd9pptx'
    const t = await openDeferPair(browser, 'pptx', slug, PARENT_FIX['pptx']!)
    // B 첨부탭을 닫는다: 파트 저장이 adopt 즉시 리셋을 유발해 POST 격리를 깨뜨린다.
    await t.attach.close().catch(() => {})
    // peer viewer page.
    const ctxC = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctxC, ADA)
    const pageC = await ctxC.newPage()
    const newCollabWs: string[] = []
    const watchWs = (tag: string, page: Page): void => {
      page.on('websocket', (ws) => {
        try {
          if (ws.url().includes('/collab')) newCollabWs.push(`${tag}:${ws.url()}`)
        } catch { /* 무시 */ }
      })
    }
    // 리셋 감시: 삽입 시점 이후 새로 열리는 collab WS가 있으면 리셋이다.
    // (초기 접속은 셋업 때 끝나므로 이후 새로 열리면 재입장이다.)
    await gotoApp(pageC)
    await openEditor(pageC, t.parentPath)
    await pageC.locator('[data-testid="pptx-viewer-root"]').first().waitFor({ timeout: 60000 }).catch(() => {})
    watchWs('A', t.pageA)
    watchWs('C', pageC)
    // 초기 접속 WS가 모두 열린 뒤 비운다 (이후 새로 열리면 재입장=리셋).
    await t.pageA.waitForTimeout(3000).catch(() => {})
    newCollabWs.length = 0
    try {
      // A 수렴 저장.
      await gotoSlide(t.pageA, 2)
      await typeAfterRejoin(t.pageA, t.shapes!, `${slug}-a1`)
      await clickParentSave(t.pageA)
      await expect
        .poll(() => Promise.resolve(parentDiskHas('pptx', t.abs, `${slug}-a1`, 'Body 2')), { timeout: 60000, intervals: [1000] })
        .toBe(true)
      // C 타이핑 (미저장).
      await gotoSlide(pageC, 2)
      const shapesC = t.shapes!
      await typeAfterRejoin(pageC, shapesC, `${slug}-c1`)
      // A: 슬라이드 정가운데 클릭 → 삽입 (슬라이드 rect 기준).
      const pt = await t.pageA.evaluate(() => {
        const __slide = document.querySelector('[data-testid="pptx-viewer-root"] div.relative.shadow-2xl') as HTMLElement | null
        const __root = document.querySelector('[data-testid="pptx-viewer-root"]') as HTMLElement | null
        const box = (__slide ?? __root)?.getBoundingClientRect()
        if (!box) return null
        return { x: box.left + box.width / 2, y: box.top + box.height / 2, w: box.width, h: box.height }
      })
      expect(pt).not.toBeNull()
      await t.pageA.mouse.click(pt!.x, pt!.y)
      const fxBytes = fs.readFileSync(path.join(FIX, 'embed-docx.docx')).toString('base64')
      await t.pageA.evaluate(
        ({ b64, hostPath }: { b64: string; hostPath: string }) => {
          const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
          const file = new File([bin], 'd9-insert.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
          window.dispatchEvent(new CustomEvent('officeEmbedFile', { detail: { file, hostPath } }))
        },
        { b64: fxBytes, hostPath: t.parentPath },
      )
      // 양쪽에 칩이 클릭 자리에 뜬다 (리로드 없음). 각 페이지 좌표계에서 판정.
      // d9 칩 자체를 기다린다 (setup은 라벨만일 수 있어 개수 단언 금지).
      const chipNearCenter = async (page: Page, tag: string): Promise<void> => {
        await expect
          .poll(() => page.getByTestId('ole-icon').evaluateAll((els) => els.some((e) => (e.getAttribute('aria-label') ?? '').includes('d9-insert'))), { timeout: 30000, intervals: [500] })
          .toBe(true)
        const all = await page.getByTestId('ole-icon').evaluateAll((els) =>
          els.map((e) => ({
            label: e.getAttribute('aria-label') ?? (e as HTMLElement).innerText?.slice(0, 40) ?? '?',
            box: (() => {
              const r = (e as HTMLElement).getBoundingClientRect()
              return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]
            })(),
          })),
        )
        const hit = all.find((c) => c.label.includes('d9-insert'))
        expect(hit).toBeTruthy()
        // 서버가 클릭 위치(중앙)에 두었는지 디스크로 확인 (고정 우하단이 아니어야 함).
        const zip = await JSZip.loadAsync(fs.readFileSync(t.abs))
        const slide = await zip.files['ppt/slides/slide2.xml']!.async('string')
        const m = /<p:graphicFrame>[\s\S]*?<a:off x="(\d+)" y="(\d+)"\/>/.exec(slide)
        expect(m).not.toBeNull()
        expect(`${m![1]},${m![2]}`).not.toBe('7315200,5486400')
        expect(hit!.box[2]).toBeGreaterThan(0)
        const ctr = await page.evaluate(() => {
          const __slide = document.querySelector('[data-testid="pptx-viewer-root"] div.relative.shadow-2xl') as HTMLElement | null
          const __root = document.querySelector('[data-testid="pptx-viewer-root"]') as HTMLElement | null
          const b = (__slide ?? __root)?.getBoundingClientRect()
          if (!b) return null
          return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
        })
        expect(ctr).not.toBeNull()
        const dist = Math.hypot(hit!.box[0] + hit!.box[2] / 2 - ctr!.x, hit!.box[1] + hit!.box[3] / 2 - ctr!.y)
        console.log(`[c6d] D9 ${tag} chip dist from click: ${Math.round(dist)}px`)
        expect(dist).toBeLessThan(150)
      }
      await chipNearCenter(t.pageA, 'A')
      await chipNearCenter(pageC, 'C')
      // 리셋 없음: 새 collab WS가 열리면 안 된다.
      expect(newCollabWs).toEqual([])
      // 양쪽 타이핑 계속 → 저장 → 디스크 수렴.
      // C가 A2를 받기 전에 저장하면 A2가 덮인다 — Yjs 전파를 기다렸다가 저장한다.
      // 덧붙이기 (editShapeText는 전체 교체라 기존 마커가 지워진다).
      await appendShapeText(t.pageA, t.shapes!, ` ${slug}-a2`)
      await clickParentSave(t.pageA)
      await expect
        .poll(() => Promise.resolve(parentDiskHas('pptx', t.abs, `${slug}-a2`, 'Body 2')), { timeout: 60000, intervals: [1000] })
        .toBe(true)
      const a2marker = `${slug}-a2`
      await expect
        .poll(
          () =>
            pageC.evaluate((m: string) => {
              const els = [...document.querySelectorAll('[data-element-id]')] as HTMLElement[]
              return els.some((e) => (e.textContent ?? '').includes(m))
            }, a2marker),
          { timeout: 60000, intervals: [1000] },
        )
        .toBe(true)
      await appendShapeText(pageC, shapesC, ` ${slug}-c2`)
      await clickParentSave(pageC)
      await expect
        .poll(() => Promise.resolve(parentDiskHas('pptx', t.abs, `${slug}-c2`, 'Body 2')), { timeout: 60000, intervals: [1000] })
        .toBe(true)
      await expect
        .poll(() => Promise.resolve(parentDiskHas('pptx', t.abs, `${slug}-a2`, 'Body 2')), { timeout: 30000, intervals: [1000] })
        .toBe(true)
      console.log(`[c6d] D9 insert merged without reset`)
    } finally {
      await pageC.close().catch(() => {})
      await ctxC.close().catch(() => {})
      await t.ctxA.close().catch(() => {})
      await t.ctxB.close().catch(() => {})
    }
  })

  test('D9-xlsx: 타이핑 중 삽입 → 리셋 없이 칩이 클릭 셀에 (백그라운드 병합)', async ({
    browser,
  }, testInfo) => {
    testInfo.setTimeout(420000)
    const slug = 'c6dd9xlsx'
    const t = await openDeferPair(browser, 'xlsx', slug, PARENT_FIX['xlsx']!)
    await t.attach.close().catch(() => {})
    const ctxC = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctxC, ADA)
    const pageC = await ctxC.newPage()
    const newCollabWs: string[] = []
    const watchWs = (tag: string, page: Page): void => {
      page.on('websocket', (ws) => {
        try {
          if (ws.url().includes('/collab')) newCollabWs.push(`${tag}:${ws.url()}`)
        } catch { /* 무시 */ }
      })
    }
    await gotoApp(pageC)
    await openEditor(pageC, t.parentPath)
    await pageC.locator('xlsx-editor [part~=formula-bar] textarea').first().waitFor({ timeout: 60000 }).catch(() => {})
    watchWs('A', t.pageA)
    watchWs('C', pageC)
    await t.pageA.waitForTimeout(3000).catch(() => {})
    newCollabWs.length = 0
    try {
      await setCell(t.pageA, 'A1', `${slug}-a1`)
      await expect
        .poll(() => Promise.resolve(parentDiskHas('xlsx', t.abs, `${slug}-a1`)), { timeout: 60000, intervals: [1000] })
        .toBe(true)
      await setCell(pageC, 'A1', `${slug}-c1`)
      // C5 선택 → 삽입 (선택 셀이 앵커가 된다).
      await t.pageA.evaluate(() => {
        const ed = document.querySelector('xlsx-editor') as unknown as { select?: (r: string) => void; focusGrid?: () => void } | null
        try { ed?.select?.('C5') } catch { /* 무시 */ }
        try { ed?.focusGrid?.() } catch { /* 무시 */ }
      })
      const fxBytes = fs.readFileSync(path.join(FIX, 'embed-docx.xlsx')).toString('base64')
      await t.pageA.evaluate(
        ({ b64, hostPath }: { b64: string; hostPath: string }) => {
          const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
          const file = new File([bin], 'd9-insert.xlsx', { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
          window.dispatchEvent(new CustomEvent('officeEmbedFile', { detail: { file, hostPath } }))
        },
        { b64: fxBytes, hostPath: t.parentPath },
      )
      // 양쪽에 칩이 C5 근처에 뜬다 (리로드 없음).
      // d9 칩 자체를 기다린다 (픽스처에 기존 칩이 있을 수 있어 개수 단언 금지).
      const chipNearCell = async (page: Page, tag: string): Promise<void> => {
        await expect
          .poll(
            async () =>
              page
                .getByTestId('ole-icon')
                .evaluateAll((els) => els.some((e) => (e.getAttribute('aria-label') ?? '').includes('d9-insert'))),
            { timeout: 30000, intervals: [500] },
          )
          .toBe(true)
        const all = await page.getByTestId('ole-icon').evaluateAll((els) =>
          els.map((e) => ({
            label: e.getAttribute('aria-label') ?? (e as HTMLElement).innerText?.slice(0, 40) ?? '?',
            box: (() => {
              const r = (e as HTMLElement).getBoundingClientRect()
              return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]
            })(),
          })),
        )
        const hit = all.find((c) => c.label.includes('d9-insert'))
        console.log(`[c6d] D9 ${tag} allchips: ${JSON.stringify(all).slice(0, 400)}`)
        expect(hit).toBeTruthy()
        // 서버가 C5(col 2,row 4)에 두었는지 디스크로 확인 (기본 앵커가 아님).
        // 앵커는 추가된 순서대로 쌓이므로 마지막 것을 본다.
        const zip = await JSZip.loadAsync(fs.readFileSync(t.abs))
        const drawing = await zip.files['xl/drawings/drawing1.xml']!.async('string')
        const froms = [...drawing.matchAll(/<xdr:from><xdr:col>(\d+)<\/xdr:col>[\s\S]*?<xdr:row>(\d+)<\/xdr:row>/g)]
        const m = froms.length > 0 ? froms[froms.length - 1]! : null
        console.log(`[c6d] D9 ${tag} drawing from: ${m ? `${m[1]},${m[2]}` : 'n/a'}`)
        expect(m).not.toBeNull()
        expect([m![1], m![2]].join(',')).toBe('2,4')
        // C5 셀 화면 위치와 칩 비교 (독립 계산).
        const cell = await page.evaluate(() => {
          const ed = document.querySelector('xlsx-editor') as unknown as { shadowRoot?: ShadowRoot | null } | null
          const cells = ed?.shadowRoot?.querySelector('.xg-cells') as unknown as {
            getBoundingClientRect: () => DOMRect
            clientWidth: number
            clientHeight: number
            scrollLeft: number
            scrollTop: number
            querySelector: (s: string) => Element | null
          } | null
          if (!cells) return null
          const gr = cells.getBoundingClientRect()
          let cw = 64
          let chh = 20
          try {
            const s = cells.querySelector('.xg-c') as unknown as { getBoundingClientRect: () => DOMRect } | null
            if (s) {
              const r = s.getBoundingClientRect()
              if (r.width > 4 && r.height > 4) {
                cw = r.width
                chh = r.height
              }
            }
          } catch { /* 무시 */ }
          return { x: gr.left + 2 * cw - cells.scrollLeft, y: gr.top + 4 * chh - cells.scrollTop, cw, ch: chh }
        })
        expect(cell).not.toBeNull()
        const dist = Math.hypot(hit!.box[0] + hit!.box[2] / 2 - (cell!.x + cell!.cw / 2), hit!.box[1] + hit!.box[3] / 2 - (cell!.y + cell!.ch / 2))
        console.log(`[c6d] D9 ${tag} chip dist from C5: ${Math.round(dist)}px`)
        expect(dist).toBeLessThan(200)
      }
      await chipNearCell(t.pageA, 'A')
      await chipNearCell(pageC, 'C')
      // 리셋 없음.
      expect(newCollabWs).toEqual([])
      // 양쪽 타이핑 계속 → 저장 → 디스크 수렴 (병합 보존).
      await setCell(t.pageA, 'B2', `${slug}-a2`)
      await clickParentSave(t.pageA)
      await expect
        .poll(() => Promise.resolve(parentDiskHas('xlsx', t.abs, `${slug}-a2`)), { timeout: 60000, intervals: [1000] })
        .toBe(true)
      await setCell(pageC, 'D4', `${slug}-c2`)
      await clickParentSave(pageC)
      await expect
        .poll(() => Promise.resolve(parentDiskHas('xlsx', t.abs, `${slug}-c2`)), { timeout: 60000, intervals: [1000] })
        .toBe(true)
      console.log(`[c6d] D9 xlsx insert merged without reset`)
    } finally {
      await pageC.close().catch(() => {})
      await ctxC.close().catch(() => {})
      await t.ctxA.close().catch(() => {})
      await t.ctxB.close().catch(() => {})
    }
  })

  test('D9-docx: 타이핑 중 삽입 → 리셋 없이 칩이 커서 문단에 (백그라운드 병합)', async ({
    browser,
  }, testInfo) => {
    testInfo.setTimeout(420000)
    const slug = 'c6dd9docx'
    const t = await openDeferPair(browser, 'docx', slug, PARENT_FIX['docx']!)
    await t.attach.close().catch(() => {})
    const ctxC = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctxC, ADA)
    const pageC = await ctxC.newPage()
    const newCollabWs: string[] = []
    const watchWs = (tag: string, page: Page): void => {
      page.on('websocket', (ws) => {
        try {
          if (ws.url().includes('/collab')) newCollabWs.push(`${tag}:${ws.url()}`)
        } catch { /* 무시 */ }
      })
    }
    await gotoApp(pageC)
    await openEditor(pageC, t.parentPath)
    await pageC.locator('docx-editor').first().waitFor({ timeout: 60000 }).catch(() => {})
    watchWs('A', t.pageA)
    watchWs('C', pageC)
    await t.pageA.waitForTimeout(3000).catch(() => {})
    newCollabWs.length = 0
    try {
      await typeDocx(t.pageA, `${slug}-a1`)
      await clickParentSave(t.pageA)
      await expect
        .poll(() => Promise.resolve(parentDiskHas('docx', t.abs, `${slug}-a1`)), { timeout: 60000, intervals: [1000] })
        .toBe(true)
      await typeDocx(pageC, `${slug}-c1`)
      // M1 문단이 있는 곳을 클릭 → 커서를 그리로 (삽입 위치).
      // (크롬 문단을 클릭하면 커서가 안 옮겨질 수 있어 텍스트로 찾는다.)
      const pt = await t.pageA.evaluate((marker: string) => {
        const ed = document.querySelector('docx-editor') as unknown as { shadowRoot?: ShadowRoot | null } | null
        const sr = ed?.shadowRoot as unknown as { querySelectorAll?: (s: string) => NodeListOf<Element> } | null
        const paras = sr?.querySelectorAll ? Array.from(sr.querySelectorAll('p')) as HTMLElement[] : []
        const el = paras.find((p) => (p.innerText ?? '').includes(marker)) ?? paras[paras.length - 1]
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
      }, `${slug}-a1`)
      expect(pt).not.toBeNull()
      await t.pageA.mouse.click(pt!.x, pt!.y)
      const fxBytes = fs.readFileSync(path.join(FIX, 'embed-docx.docx')).toString('base64')
      await t.pageA.evaluate(
        ({ b64, hostPath }: { b64: string; hostPath: string }) => {
          const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
          const file = new File([bin], 'd9-insert.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
          window.dispatchEvent(new CustomEvent('officeEmbedFile', { detail: { file, hostPath } }))
        },
        { b64: fxBytes, hostPath: t.parentPath },
      )
      // 양쪽에 칩이 클릭 문단 근처에 뜬다 (리로드 없음).
      // d9 칩 자체를 기다린다 (픽스처에 기존 칩이 있을 수 있어 개수 단언 금지).
      const chipNearPara = async (page: Page, tag: string): Promise<void> => {
        await expect
          .poll(
            async () =>
              page
                .getByTestId('ole-icon')
                .evaluateAll((els) => els.some((e) => (e.getAttribute('aria-label') ?? '').includes('d9-insert'))),
            { timeout: 30000, intervals: [500] },
          )
          .toBe(true)
        const all = await page.getByTestId('ole-icon').evaluateAll((els) =>
          els.map((e) => ({
            label: e.getAttribute('aria-label') ?? (e as HTMLElement).innerText?.slice(0, 40) ?? '?',
            box: (() => {
              const r = (e as HTMLElement).getBoundingClientRect()
              return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]
            })(),
          })),
        )
        const hit = all.find((c) => c.label.includes('d9-insert'))
        expect(hit).toBeTruthy()
        // 서버가 클릭 문단 뒤에 두었는지 디스크로 확인 (문서 끝이 아님).
        const zip = await JSZip.loadAsync(fs.readFileSync(t.abs))
        const doc = await zip.files['word/document.xml']!.async('string')
        const objAt = doc.indexOf('<w:object')
        expect(objAt).toBeGreaterThan(-1)
        const objParaEnd = doc.indexOf('</w:p>', objAt)
        expect(objParaEnd).toBeGreaterThan(objAt)
        // 오브젝트 문단 뒤에 다른 문단이 있어야 한다 (끝이 아님).
        expect(doc.slice(objParaEnd).includes('<w:p')).toBe(true)
        // 클릭 문단 근처인지 (같은 페이지 좌표계).
        // 칩은 문단 시작점(좌상단)에 붙는다 — 넓은 문단의 가운데와 비교하면 안 된다.
        const para = await page.evaluate((marker: string) => {
          const ed = document.querySelector('docx-editor') as unknown as { shadowRoot?: ShadowRoot | null } | null
          const sr = ed?.shadowRoot as unknown as { querySelectorAll?: (s: string) => NodeListOf<Element> } | null
          const paras = sr?.querySelectorAll ? Array.from(sr.querySelectorAll('p')) as HTMLElement[] : []
          const el = paras.find((p) => (p.innerText ?? '').includes(marker)) ?? paras[paras.length - 1]
          if (!el) return null
          const r = el.getBoundingClientRect()
          return { x: r.left, y: r.top }
        }, `${slug}-a1`)
        expect(para).not.toBeNull()
        const dist = Math.hypot(hit!.box[0] + hit!.box[2] / 2 - para!.x, hit!.box[1] + hit!.box[3] / 2 - para!.y)
        console.log(`[c6d] D9 ${tag} chip dist from para: ${Math.round(dist)}px`)
        expect(dist).toBeLessThan(200)
      }
      await chipNearPara(t.pageA, 'A')
      await chipNearPara(pageC, 'C')
      // 리셋 없음.
      expect(newCollabWs).toEqual([])
      // 양쪽 타이핑 계속 → 저장 → 디스크 수렴 (병합 보존).
      await typeDocx(t.pageA, `${slug}-a2`)
      await clickParentSave(t.pageA)
      await expect
        .poll(() => Promise.resolve(parentDiskHas('docx', t.abs, `${slug}-a2`)), { timeout: 60000, intervals: [1000] })
        .toBe(true)
      await typeDocx(pageC, `${slug}-c2`)
      await clickParentSave(pageC)
      await expect
        .poll(() => Promise.resolve(parentDiskHas('docx', t.abs, `${slug}-c2`)), { timeout: 60000, intervals: [1000] })
        .toBe(true)
      console.log(`[c6d] D9 docx insert merged without reset`)
    } finally {
      await pageC.close().catch(() => {})
      await ctxC.close().catch(() => {})
      await t.ctxA.close().catch(() => {})
      await t.ctxB.close().catch(() => {})
    }
  })

  test('D10-pptx: 리본 대신 실제 파일선택으로 삽입 → 칩이 클릭 자리에 (백그라운드 병합)', async ({
    browser,
  }, testInfo) => {
    testInfo.setTimeout(420000)
    const slug = 'c6dd10pptx'
    const t = await openDeferPair(browser, 'pptx', slug, PARENT_FIX['pptx']!)
    await t.attach.close().catch(() => {})
    const ctxC = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctxC, ADA)
    const pageC = await ctxC.newPage()
    const newCollabWs: string[] = []
    const watchWs = (tag: string, page: Page): void => {
      page.on('websocket', (ws) => {
        try {
          if (ws.url().includes('/collab')) newCollabWs.push(`${tag}:${ws.url()}`)
        } catch { /* 무시 */ }
      })
    }
    await gotoApp(pageC)
    await openEditor(pageC, t.parentPath)
    await pageC.locator('[data-testid="pptx-viewer-root"]').first().waitFor({ timeout: 60000 }).catch(() => {})
    // C도 2번 슬라이드로 (같은 슬라이드에서 칩을 봐야 한다).
    await gotoSlide(pageC, 2)
    // 리셋 감시: 리셋은 뷰어를 통째로 다시 마운트한다 (DOM 노드 교체로 감지).
    const rootA = await t.pageA.$('[data-testid="pptx-viewer-root"]')
    const rootC = await pageC.$('[data-testid="pptx-viewer-root"]')
    expect(rootA).not.toBeNull()
    expect(rootC).not.toBeNull()
    try {
      await gotoSlide(t.pageA, 2)
      // 슬라이드 정가운데 클릭 → 숨은 input에 실제 파일 세팅 (리본 파일선택과 동일 경로).
      const pt = await t.pageA.evaluate(() => {
        const __slide = document.querySelector('[data-testid="pptx-viewer-root"] div.relative.shadow-2xl') as HTMLElement | null
        const __root = document.querySelector('[data-testid="pptx-viewer-root"]') as HTMLElement | null
        const b = (__slide ?? __root)?.getBoundingClientRect()
        if (!b) return null
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
      })
      expect(pt).not.toBeNull()
      await t.pageA.mouse.click(pt!.x, pt!.y)
      const fxPath = path.resolve(FIX, 'embed-docx.docx')
      await t.pageA.locator('input[data-testid="office-attach-input"]').setInputFiles(fxPath)
      // 디스크에 파트가 생기고, 양쪽에 칩이 클릭 자리에 뜬다 (리로드 없음).
      await expect
        .poll(async () => {
          const zip = await JSZip.loadAsync(fs.readFileSync(t.abs))
          return Object.keys(zip.files).some((n) => n === 'ppt/embeddings/embed-docx.docx')
        }, { timeout: 60000, intervals: [1000] })
        .toBe(true)
      try {
        const zip0 = await JSZip.loadAsync(fs.readFileSync(t.abs))
        const s2 = await zip0.files['ppt/slides/slide2.xml']!.async('string')
        const m0 = /<p:graphicFrame>[\s\S]*?<a:off x="(\d+)" y="(\d+)"\/>/.exec(s2)
        console.log(`[c6d] D10 diskOff: ${m0 ? `${m0[1]},${m0[2]}` : 'no-frame'}`)
      } catch (e) {
        console.log(`[c6d] D10 diskOff err ${(e as Error).message}`)
      }
      const chipNearCenter = async (page: Page, tag: string): Promise<void> => {
        // 선택 해제 (속성 사이드바가 열리면 viewer 중심이 어긋난다).
        await page.keyboard.press('Escape').catch(() => {})
        await page.waitForTimeout(1000).catch(() => {})
        // img 중심을 잰다 (라벨은 img 아래에 붙어 박스 중심을 밀어내므로 제외).
        const allc = await page.getByTestId('ole-icon').evaluateAll((els) =>
          els.map((e) => {
            const img = (e as HTMLElement).querySelector('[data-testid="ole-img"]') as HTMLElement | null
            const r = (img ?? (e as HTMLElement)).getBoundingClientRect()
            return { label: e.getAttribute('aria-label') ?? '?', box: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)] }
          }),
        )
        // 정확한 aria-label 일치로 잰다 (getByTestId name 옵션은 유사 항목을 잡을 수 있음).
        const hit = allc.find((c) => c.label === '첨부 embed-docx.docx')
        expect(hit).toBeTruthy()
        const box = { x: hit!.box[0], y: hit!.box[1], width: hit!.box[2], height: hit!.box[3] }
        expect(box.width).toBeGreaterThan(0)
        // 라벨 텍스트가 파일명과 같다 (ole-label).
        const labelText = await page.getByTestId('ole-label').evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()))
        console.log(`[c6d] D10 ${tag} labels: ${JSON.stringify(labelText)}`)
        expect(labelText.some((t) => t.includes('embed-docx.docx'))).toBe(true)
        const ctr = await page.evaluate(() => {
          const __slide = document.querySelector('[data-testid="pptx-viewer-root"] div.relative.shadow-2xl') as HTMLElement | null
          const __root = document.querySelector('[data-testid="pptx-viewer-root"]') as HTMLElement | null
          const b = (__slide ?? __root)?.getBoundingClientRect()
          if (!b) return null
          return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
        })
        expect(ctr).not.toBeNull()
        const dist = Math.hypot(box!.x + box!.width / 2 - ctr!.x, box!.y + box!.height / 2 - ctr!.y)
        console.log(`[c6d] D10 ${tag} chip dist from center: ${Math.round(dist)}px`)
        // C7c-2: translate 중앙 정렬 — 칩 중심이 기준점에서 ±8px 안.
        expect(dist).toBeLessThan(8)
      }
      await chipNearCenter(t.pageA, 'A')
      await chipNearCenter(pageC, 'C')
      // 리셋 없음: 뷰어가 다시 마운트되지 않았다 (화면이 날아가지 않음).
      expect(newCollabWs).toEqual([])
      await expect.poll(() => rootA!.evaluate((e) => e.isConnected), { timeout: 10000 }).toBe(true)
      await expect.poll(() => rootC!.evaluate((e) => e.isConnected), { timeout: 10000 }).toBe(true)
      console.log(`[c6d] D10 picker insert merged without reset`)
    } finally {
      await pageC.close().catch(() => {})
      await ctxC.close().catch(() => {})
      await t.ctxA.close().catch(() => {})
      await t.ctxB.close().catch(() => {})
    }
  })

  test('D12-pptx: 같은 슬라이드에 2회 삽입하면 위치가 다르고 둘 다 보인다 (겹침 방지)', async ({
    browser,
  }, testInfo) => {
    testInfo.setTimeout(420000)
    const slug = 'c6dd12pptx'
    const t = await openDeferPair(browser, 'pptx', slug, PARENT_FIX['pptx']!)
    await t.attach.close().catch(() => {})
    const ctxC = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctxC, ADA)
    const pageC = await ctxC.newPage()
    try {
      await gotoApp(pageC)
      await openEditor(pageC, t.parentPath)
      await pageC.locator('[data-testid="pptx-viewer-root"]').first().waitFor({ timeout: 60000 }).catch(() => {})
      await gotoSlide(pageC, 2)
      await gotoSlide(t.pageA, 2)
      const rootA = await t.pageA.$('[data-testid="pptx-viewer-root"]')
      const rootC = await pageC.$('[data-testid="pptx-viewer-root"]')
      const doInsert = async (fname: string): Promise<void> => {
        const fxBytes = fs.readFileSync(path.join(FIX, 'embed-docx.docx')).toString('base64')
        await t.pageA.evaluate(
          ({ b64, hostPath, nm }: { b64: string; hostPath: string; nm: string }) => {
            const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
            const file = new File([bin], nm, { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
            window.dispatchEvent(new CustomEvent('officeEmbedFile', { detail: { file, hostPath } }))
          },
          { b64: fxBytes, hostPath: t.parentPath, nm: fname },
        )
      }
      await doInsert('d12-first.docx')
      await expect
        .poll(async () => {
          const zip = await JSZip.loadAsync(fs.readFileSync(t.abs))
          return Object.keys(zip.files).some((n) => n === 'ppt/embeddings/d12-first.docx')
        }, { timeout: 60000, intervals: [1000] })
        .toBe(true)
      await doInsert('d12-second.docx')
      await expect
        .poll(async () => {
          const zip = await JSZip.loadAsync(fs.readFileSync(t.abs))
          return Object.keys(zip.files).some((n) => n === 'ppt/embeddings/d12-second.docx')
        }, { timeout: 60000, intervals: [1000] })
        .toBe(true)
      // 두 도형의 a:off가 서로 다르다 (겹치지 않음).
      const zip = await JSZip.loadAsync(fs.readFileSync(t.abs))
      const s2 = await zip.files['ppt/slides/slide2.xml']!.async('string')
      const offs = [...s2.matchAll(/<p:graphicFrame>[\s\S]*?<a:off x="(\d+)" y="(\d+)"\/>/g)].map((m) => `${m[1]},${m[2]}`)
      console.log(`[c6d] D12 offs: ${JSON.stringify(offs)}`)
      expect(offs.length).toBeGreaterThanOrEqual(2)
      expect(new Set(offs).size).toBe(offs.length)
      // 둘 다 칩으로 보인다 (A·C).
      for (const [page, tag] of [[t.pageA, 'A'], [pageC, 'C']] as Array<[Page, string]>) {
        for (const nm of ['d12-first.docx', 'd12-second.docx']) {
          await expect
            .poll(() => page.getByTestId('ole-icon').evaluateAll((els, n) => els.some((e) => (e.getAttribute('aria-label') ?? '').includes(n as string)), nm), { timeout: 30000, intervals: [500] })
            .toBe(true)
        }
        console.log(`[c6d] D12 ${tag} both chips visible`)
      }
      // 리셋 없음.
      await expect.poll(() => rootA!.evaluate((e) => e.isConnected), { timeout: 10000 }).toBe(true)
      await expect.poll(() => rootC!.evaluate((e) => e.isConnected), { timeout: 10000 }).toBe(true)
      console.log(`[c6d] D12 two inserts offset without reset`)
    } finally {
      await pageC.close().catch(() => {})
      await ctxC.close().catch(() => {})
      await t.ctxA.close().catch(() => {})
      await t.ctxB.close().catch(() => {})
    }
  })

  test('D13-pptx: 방 재생성 후 예전 첨부가 백필되어 정위치에 보인다', async ({
    browser,
  }, testInfo) => {
    testInfo.setTimeout(420000)
    const slug = 'c6dd13pptx'
    const t = await openDeferPair(browser, 'pptx', slug, PARENT_FIX['pptx']!)
    await t.attach.close().catch(() => {})
    try {
      await gotoSlide(t.pageA, 2)
      const fxBytes = fs.readFileSync(path.join(FIX, 'embed-docx.docx')).toString('base64')
      await t.pageA.evaluate(
        ({ b64, hostPath }: { b64: string; hostPath: string }) => {
          const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
          const file = new File([bin], 'd13-keep.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
          window.dispatchEvent(new CustomEvent('officeEmbedFile', { detail: { file, hostPath } }))
        },
        { b64: fxBytes, hostPath: t.parentPath },
      )
      await expect
        .poll(async () => {
          const zip = await JSZip.loadAsync(fs.readFileSync(t.abs))
          return Object.keys(zip.files).some((n) => n === 'ppt/embeddings/d13-keep.docx')
        }, { timeout: 60000, intervals: [1000] })
        .toBe(true)
      // 전부 닫아 방을 비운다 (TTL 30초+스윕 만료 대기 → dispose → knownEmbeds 소멸).
      await t.ctxA.close().catch(() => {})
      await t.ctxB.close().catch(() => {})
      await new Promise((r) => setTimeout(r, 45000))
      // 같은 파일 재입장 → 새 방 + 백필.
      const ctxA2 = await browser.newContext({ viewport: { width: 1400, height: 900 } })
      await seedUser(ctxA2, ADA)
      const pageA2 = await ctxA2.newPage()
      try {
        await gotoApp(pageA2)
        await openEditor(pageA2, t.parentPath)
        await pageA2.locator('[data-testid="pptx-viewer-root"]').first().waitFor({ timeout: 60000 })
        await gotoSlide(pageA2, 2)
        // 칩이 있고 좌상단 폴백이 아니라 가운데 근처다 (백필 정위치).
        await expect
          .poll(() => pageA2.getByTestId('ole-icon').evaluateAll((els) => els.some((e) => (e.getAttribute('aria-label') ?? '').includes('d13-keep.docx'))), { timeout: 60000, intervals: [1000] })
          .toBe(true)
        const allc = await pageA2.getByTestId('ole-icon').evaluateAll((els) =>
          els.map((e) => ({ label: e.getAttribute('aria-label') ?? '?', box: (() => { const r = (e as HTMLElement).getBoundingClientRect(); return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; })() })),
        )
        console.log(`[c6d] D13 allchips: ${JSON.stringify(allc)}`)
        const hit = allc.find((c) => c.label === '첨부 d13-keep.docx')
        expect(hit).toBeTruthy()
        const box = { x: hit!.box[0], y: hit!.box[1], width: hit!.box[2], height: hit!.box[3] }
        expect(box.width).toBeGreaterThan(0)
        const ctr = await pageA2.evaluate(() => {
          const __slide = document.querySelector('[data-testid="pptx-viewer-root"] div.relative.shadow-2xl') as HTMLElement | null
          const __root = document.querySelector('[data-testid="pptx-viewer-root"]') as HTMLElement | null
          const b = (__slide ?? __root)?.getBoundingClientRect()
          if (!b) return null
          return { x: b.left + b.width / 2, y: b.top + b.height / 2 }
        })
        expect(ctr).not.toBeNull()
        const dist = Math.hypot(box!.x + box!.width / 2 - ctr!.x, box!.y + box!.height / 2 - ctr!.y)
        console.log(`[c6d] D13 backfilled chip dist from center: ${Math.round(dist)}px`)
        expect(dist).toBeLessThan(200)
        // 라벨도 있다.
        const labels = await pageA2.getByTestId('ole-label').evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()))
        expect(labels.some((t) => t.includes('d13-keep.docx'))).toBe(true)
        console.log(`[c6d] D13 backfilled chip positioned after room recreate`)
      } finally {
        await pageA2.close().catch(() => {})
        await ctxA2.close().catch(() => {})
      }
    } finally {
      await t.ctxA.close().catch(() => {})
      await t.ctxB.close().catch(() => {})
    }
  })

  test('D16-pptx: A가 첨부 선택하면 C에 피어 표시가 뜬다 (awareness)', async ({
    browser,
  }, testInfo) => {
    testInfo.setTimeout(420000)
    const slug = 'c6dd16pptx'
    const t = await openDeferPair(browser, 'pptx', slug, PARENT_FIX['pptx']!)
    await t.attach.close().catch(() => {})
    const ctxC = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    await seedUser(ctxC, GRACE)
    const pageC = await ctxC.newPage()
    try {
      await gotoApp(pageC)
      await openEditor(pageC, t.parentPath)
      await pageC.locator('[data-testid="pptx-viewer-root"]').first().waitFor({ timeout: 60000 }).catch(() => {})
      await gotoSlide(pageC, 2)
      await gotoSlide(t.pageA, 2)
      const fxBytes = fs.readFileSync(path.join(FIX, 'embed-docx.docx')).toString('base64')
      await t.pageA.evaluate(
        ({ b64, hostPath }: { b64: string; hostPath: string }) => {
          const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
          const file = new File([bin], 'd16-sel.docx', { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
          window.dispatchEvent(new CustomEvent('officeEmbedFile', { detail: { file, hostPath } }))
        },
        { b64: fxBytes, hostPath: t.parentPath },
      )
      // 양쪽에 칩이 뜰 때까지 대기 (106 수신).
      for (const [page, tag] of [[t.pageA, 'A'], [pageC, 'C']] as Array<[Page, string]>) {
        await expect
          .poll(() => page.getByTestId('ole-icon').evaluateAll((els) => els.some((e) => (e.getAttribute('aria-label') ?? '').includes('d16-sel.docx'))), { timeout: 60000, intervals: [1000] })
          .toBe(true)
        console.log(`[c6d] D16 ${tag} chip visible`)
      }
      // A가 가운데 클릭 → 선택. C에 Ada 배지가 떠야 한다.
      const boxA = await t.pageA.getByTestId('ole-icon').evaluateAll((els) => {
        const hit = els.find((e) => (e.getAttribute('aria-label') ?? '') === '첨부 d16-sel.docx') as HTMLElement | null
        if (!hit) return null
        const r = hit.getBoundingClientRect()
        return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]
      })
      expect(boxA).not.toBeNull()
      await t.pageA.mouse.click(boxA![0], boxA![1])
      await expect
        .poll(() => pageC.getByTestId('ole-peer').evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim())), { timeout: 30000, intervals: [500] })
        .toContain('Ada')
      console.log(`[c6d] D16 peer badge visible on C`)
      // A 본인에게는 피어 배지가 뜨지 않는다 (자기 제외).
      const selfBadges = await t.pageA.getByTestId('ole-peer').evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()))
      expect(selfBadges.some((t) => t.includes('Ada'))).toBe(false)
      console.log(`[c6d] D16 no self-echo on A`)
    } finally {
      await pageC.close().catch(() => {})
      await ctxC.close().catch(() => {})
      await t.ctxA.close().catch(() => {})
      await t.ctxB.close().catch(() => {})
    }
  })

  test('D4-pptx: 미룸 중 부모 탭을 닫으면 즉시 dispose — 늦은 저장은 404, 재입장 후 정상 저장', async ({
    browser,
  }, testInfo) => {
    testInfo.setTimeout(420000)
    const slug = 'c6dd4pptx'
    const t = await openDeferPair(browser, 'pptx', slug, PARENT_FIX['pptx']!)
    try {
      // A 입력 후 자동저장이 수렴한 뒤에 B의 파트 교체를 HTTP로 한다 (U-http 패턴).
      // 자동저장이 수렴해야 PUT의 base가 안정적이다 (D1/D3와 동일).
      await editShapeText(t.pageA, t.shapes!, `${slug}-ready`, `${slug}-a1`)
      await expect
        .poll(() => Promise.resolve(parentDiskHas('pptx', t.abs, `${slug}-a1`, 'Body 2')), { timeout: 60000, intervals: [1000] })
        .toBe(true)
      const token = `c6d-${Date.now().toString(36)}`
      const lock = (await fetch(`${backendBase()}/api/collab/embed/lock`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: t.parentPath, part: t.part, name: 'c6d-d4', token }),
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
        console.log(`[c6d] D4 B-save ok, deferred=${put.hasPendingPartChange === true}`)
      } finally {
        await fetch(`${backendBase()}/api/collab/embed/lock`, {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: t.parentPath, part: t.part, lockId: lock.lockId!, token }),
        }).catch(() => {})
      }
      // 현재 방 epoch 기록 (재입장 후 달라져야 즉시 dispose 증명).
      const fileName = t.parentPath.split('/').pop()!
      const roomOf = async () => {
        const body = (await fetch(`${backendBase()}/api/collab/rooms`).then((r) => r.json())) as {
          rooms?: Array<{ roomId?: string; rel?: string; part?: string; epoch?: string }>
        }
        return (body.rooms ?? []).find((r) => (r.rel ?? '').endsWith(fileName) && !r.part)
      }
      const before = await roomOf()
      expect(before?.roomId).toBeTruthy()
      // 닫기 직전 한 번 더 입력한다 (미저장 상태로 닫기 — 실제 사용자 패턴).
      // 자동저장 debounce 안에 닫히므로 in-flight 저장 경합도 자연스럽게 포함된다.
      await gotoSlide(t.pageA, 2)
      await typeAfterRejoin(t.pageA, t.shapes!, `${slug}-a1q`)
      // 미룸 중 부모 탭을 닫는다 (beforeunload 확인창은 수락).
      t.pageA.on('dialog', (d) => {
        void d.accept().catch(() => {})
      })
      await t.pageA.close()
      await t.ctxA.close().catch(() => {})
      // 늦은 저장: 방이 없으면 404 (조용한 유실/덮개 금지). 즉시 dispose 증명이기도 하다.
      const diskHash = createHash('sha256').update(fs.readFileSync(t.abs)).digest('hex')
      await expect
        .poll(
          async () =>
            fetch(`${backendBase()}/api/collab/save`, {
              method: 'POST',
              headers: {
                'content-type': 'application/octet-stream',
                'x-collab-room': before!.roomId!,
                'x-collab-client': '424242',
                'x-collab-base-hash': diskHash,
                'x-collab-epoch': 'stale-after-close',
              },
              body: fs.readFileSync(t.abs),
            }).then((r) => r.status),
          { timeout: 15000, intervals: [500] },
        )
        .toBe(404)
      console.log(`[c6d] D4 late save after close → 404 (fail-closed)`)
      // 디스크는 그대로다 (adopt된 첨부 보존, 닫기로 인한 손상 없음).
      expect(await partDiskHas(t.abs, t.part, `${slug}-b1`)).toBe(true)
      // 재입장: 새 방·새 epoch, 저장 정상 (무한 409 루프 없음).
      const ctxA2 = await browser.newContext({ viewport: { width: 1400, height: 900 } })
      await seedUser(ctxA2, ADA)
      const pageA2 = await ctxA2.newPage()
      await gotoApp(pageA2)
      try {
        await openEditor(pageA2, t.parentPath)
        await gotoSlide(pageA2, 2)
        const shapes2 = new ShapeLocator(pageA2)
        const curText = await pageA2.evaluate(() => {
          const els = [...document.querySelectorAll('[data-element-id]')] as HTMLElement[]
          const el = els.find((e) => (e.textContent || '').trim().length > 1)
          return el ? (el.textContent ?? null) : null
        })
        expect(curText).not.toBeNull()
        await editShapeText(pageA2, shapes2, curText!, `${slug}-a2`)
        await clickParentSave(pageA2)
        await expect
          .poll(() => Promise.resolve(parentDiskHas('pptx', t.abs, `${slug}-a2`, 'Body 2')), { timeout: 60000, intervals: [1000] })
          .toBe(true)
        const after = await roomOf()
        expect(after?.roomId).toBeTruthy()
        expect(after!.roomId).toBe(before!.roomId)
        expect(after!.epoch).not.toBe(before!.epoch)
        expect(await partDiskHas(t.abs, t.part, `${slug}-b1`)).toBe(true)
      } finally {
        await ctxA2.close().catch(() => {})
      }
    } finally {
      await t.ctxB.close().catch(() => {})
    }
  })
})
