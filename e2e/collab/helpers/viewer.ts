import type { Page } from '@playwright/test'

/**
 * 원격 선택 표시 선택자.
 * 근거 1 (lib): pptx-react-viewer/dist/chunk-552NAFTD.js RemoteSelectionOverlay —
 *   data-testid={`remote-selection-${sel.element.id}`},
 *   data-pptx-remote-selection={sel.element.id} (border색 + 이름 라벨 포함).
 * 근거 2 (앱): PptxViewer의 MutationObserver가 위 DOM에
 *   data-testid="collab-remote-selection" + data-peer-id를 붙인다
 *   (border색→참가자 color 매칭, 폴백 이름 라벨 매칭).
 */
export const REMOTE_SELECTION_SELECTOR = '[data-testid="collab-remote-selection"]'
export const REMOTE_SELECTION_LIB_SELECTOR = '[data-pptx-remote-selection]'

/**
 * 도형 찾기.
 * 근거: lib 도형 DOM은 data-element-id="<slide경로>-shape-<idx>"를 갖는다
 * (chunk-552NAFTD.js:14551/15286/15548, 셀렉터 패턴 9867행
 * `[data-element-id="..."][data-pptx-element="true"]`).
 * element id는 이름이 아니라 인덱스 기반이므로, 테스트 내에서는 최초 텍스트로
 * id를 확정하고 이후에는 id로 재사용한다 (텍스트 편집 후에도 안정적).
 */
const INITIAL_TEXT: Record<string, string> = {
  'Title 1': 'Slide One',
  'Body 2': 'Hello',
  'Body 3': 'Third',
}

export class ShapeLocator {
  private ids = new Map<string, string>()
  constructor(private page: Page) {}

  async idFor(shapeName: string): Promise<string> {
    const cached = this.ids.get(shapeName)
    if (cached) return cached
    const seed = INITIAL_TEXT[shapeName] ?? shapeName
    const id = await this.page.evaluate((text) => {
      const els = [...document.querySelectorAll('[data-element-id]')]
      const el = els.find((e) => (e.textContent || '').includes(text))
      return el?.getAttribute('data-element-id') ?? null
    }, seed)
    if (!id) throw new Error(`shape not found: ${shapeName} (seed ${seed})`)
    this.ids.set(shapeName, id)
    return id
  }

  byId(id: string) {
    return this.page.locator(`[data-element-id="${CSS.escape(id)}"]`)
  }
}

export function peer(page: Page, id: string) {
  return page.locator(`[data-testid="collab-peer"][data-peer-id="${id}"]`)
}

/** 반영 지연 측정 (ms). 결과 JSONL에 기록한다. */
const latencies: { test: string; label: string; ms: number; at: string }[] = []

export async function measure<T>(test: string, label: string, fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = performance.now()
  const result = await fn()
  const ms = performance.now() - start
  latencies.push({ test, label, ms: Math.round(ms), at: new Date().toISOString() })
  console.log(`[latency] ${test} ${label}: ${Math.round(ms)}ms`)
  return { result, ms }
}

export function latencyReport(): { test: string; label: string; ms: number }[] {
  return [...latencies]
}

/** pageerror + console.error 수집기. */
export function watchErrors(page: Page) {
  const pageerrors: string[] = []
  const consoleErrors: string[] = []
  page.on('pageerror', (e) => pageerrors.push(String(e).slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300))
  })
  return {
    pageerrors,
    consoleErrors,
    assertClean(known: RegExp[] = []) {
      const unexpectedPages = pageerrors.filter((e) => !known.some((re) => re.test(e)))
      const unexpectedConsole = consoleErrors.filter((e) => !known.some((re) => re.test(e)))
      if (unexpectedPages.length > 0 || unexpectedConsole.length > 0) {
        throw new Error(
          `unexpected errors:\npageerror: ${unexpectedPages.join('\n')}\nconsole: ${unexpectedConsole.join('\n')}`,
        )
      }
    },
  }
}

export interface CollabDebug {
  mountCount: number
  curSlide?: number
  /** 화면 슬라이드 이력 (1-based). E20s가 "슬라이드 1" 통과 여부를 본다. */
  curSlideHistory?: number[]
  /** 상대 슬라이드 이력 (1-based, -1 = 값 없음). awareness 이벤트 기준. */
  peerSlideHistory?: Record<string, number[]>
  /** 마운트(=disarm)부터 첫 arm까지 ms. E20s가 300ms 창을 실제로 넘었는지 확인한다. */
  armDelayMs?: number | null
  role: 'owner' | 'collaborator' | 'viewer' | null
  synced: boolean
  ownerClientId: number | null
  clientId: number
  lastSave: { at: number; status: number } | null
  saveCount: number
  save409Count: number
  slideCountY: number
  localMode?: string | null
  imageSync?: { pictures: number; withData: number; blobOnly: number } | null
  sessionCount?: number
  /** M7/D26: awareness 누적 송·수신. 커서가 wire에서 빠졌는지 판정한다. */
  awarenessTx?: number
  awarenessRx?: number
  clientLogs?: string[]
}

export async function readDebug(page: Page): Promise<CollabDebug> {
  return page.evaluate(() => (window as unknown as { __collabDebug?: CollabDebug }).__collabDebug as CollabDebug)
}

/** 앱 진입 (VPN 간헐 차단에 재시도). */
export async function gotoApp(page: Page): Promise<void> {
  for (let i = 0; i < 8; i++) {
    try {
      // M14/M15: collabDebug=1 로 실행하며(타임라인 계측).
      // M21: 표식 단언은 **파일을 열은 뒤**에 한다 — lib 은 동적 import 라서
      // 파일을 열기 전에는 모듈이 평가되지 않아 표식이 null 이 정상이다.
      await page.goto('/?collabDebug=1&e2e=1', { waitUntil: 'domcontentloaded', timeout: 30000 })
      return
    } catch {
      await page.waitForTimeout(2000)
    }
  }
  throw new Error('goto failed')
}

/**
 * M21: 런타임 표식 단언 — lib 패치가 실제로 로드됐는지 확인한다.
 * 파일(뷰어)을 연 뒤에 호출할 것.
 */
export async function assertLibPatchesLoaded(page: Page): Promise<void> {
  const patches = await page.evaluate(
    () => (globalThis as unknown as { __ooxmlPatches?: Record<string, string> }).__ooxmlPatches ?? null,
  )
  if (!patches || patches.ui !== 'M21' || patches.viewer !== 'M21') {
    throw new Error(
      `lib patch not loaded (expected ui/viewer=M21, got ${JSON.stringify(patches)}) — ` +
        `pnpm install 로 패치를 적용하고 frontend/node_modules/.vite 캐시를 지운 뒤 다시 실행할 것.`,
    )
  }
  const deps = await page.evaluate(() =>
    performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .filter((n) => n.includes('/.vite/deps/'))
      .slice(0, 12),
  )
  console.log(`[lib-patches] ${JSON.stringify(patches)} vite-deps=${JSON.stringify(deps)}`)
}


/** 탐색기에서 파일을 열고 (편집 모드 전환 선택) 연결될 때까지 기다린다. */
export async function openFile(page: Page, fileName: string, mode: 'view' | 'edit', opts?: { folderSeg?: string }): Promise<void> {
  const seg = opts?.folderSeg ?? 'collab-e2e'
  for (let i = 0; i < 6; i++) {
    try {
      await page.getByTitle('Workspace').waitFor({ timeout: 12000 })
      break
    } catch {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {})
    }
  }
  for (let i = 0; i < 5; i++) {
    await page.getByTitle('Workspace').click({ timeout: 20000 })
    try {
      await page.waitForFunction(() => document.querySelectorAll('[data-testid="file-row"]').length > 0, null, { timeout: 10000 })
      break
    } catch {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(2000)
    }
    if (i === 4) throw new Error('workspace sheet has no rows after retries')
  }
  // 폴더 펼치기 (M9/6절 하네스 복구).
  // 이전 구현은 폴더 '이름 span'을 클릭했는데 그 클릭은 토글(expanded 반전)이라
  // 반복 클릭하면 다시 접혔다. 게다가 이름 span 을 8번 누른 뒤에는 폴더가 닫힌
  // 상태로 남고(짝수 회 토글) 파일 행이 끝내 안 보여 :186 에서 타임아웃했다.
  // 지금은 'Expand' 버튼(토글 아님)을 쓰고, 이미 펼쳐졌으면 아무것도 하지 않는다.
  for (let i = 0; i < 8; i++) {
    const has = await page.evaluate(
      (n) => [...document.querySelectorAll('[data-testid="file-row"]')].some((r) => ((r.textContent || '').includes(n))),
      fileName,
    )
    if (has) break
    const expanded = await page.evaluate((s) => {
      const norm = (p: string) => p.replace(/\\/g, '/')
      const rows = [...document.querySelectorAll('[data-testid="file-row"]')] as HTMLElement[]
      const segN = norm(s)
      const folder = rows.find((r) => norm(r.getAttribute('data-path') || '') === segN || norm(r.getAttribute('data-path') || '').endsWith('/' + segN))
      if (!folder) return 'no-folder'
      // 이미 펼쳐졌으면 자식 행이 있다
      const child = rows.some((r) => {
        const p = norm(r.getAttribute('data-path') || '')
        return p !== segN && p.startsWith(segN + '/')
      })
      if (child) return 'already-expanded'
      // Expand 버튼 클릭(토글 아님). 없으면 이름 div 폴백.
      const btn = folder.querySelector('button[title="Expand"]') as HTMLElement | null
      const target = btn ?? (folder.querySelector('div.flex-1') as HTMLElement | null) ?? folder
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      return 'clicked'
    }, seg)
    if (expanded === 'no-folder') {
      await page.waitForTimeout(1500)
      continue
    }
    await page.waitForTimeout(1500)
  }
  for (let i = 0; i < 4; i++) {
    const row = page.locator(`[data-testid="file-row"][data-path$="${fileName}"]`)
    if ((await row.count()) === 0) {
      // 마지막 시도: 폴더를 접었다 펼친다(자식이 늦게 오는 경우 대비)
      await page.evaluate((s) => {
        const norm = (p: string) => p.replace(/\\/g, '/')
        const rows = [...document.querySelectorAll('[data-testid="file-row"]')] as HTMLElement[]
        const folder = rows.find((r) => norm(r.getAttribute('data-path') || '').endsWith(s))
        const btn = folder?.querySelector('button[title="Collapse"],button[title="Expand"]') as HTMLElement | null
        btn?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      }, seg)
      await page.waitForTimeout(1500)
    }
    await row.locator('span', { hasText: fileName }).first().click({ timeout: 15000 }).catch(() => {})
    try {
      await page.getByTestId('pptx-viewer-root').waitFor({ timeout: 20000 })
      const failed = await page.getByText('Cannot preview this document').count()
      if (failed > 0) throw new Error('preview failed')
      // M21: 뷰어((lib)가 로드된 뒤에야 런타임 표식을 단언한다.
      await assertLibPatchesLoaded(page)
      break
    } catch {
      await page.waitForTimeout(3000)
    }
  }
  await page.getByTestId('pptx-viewer-root').waitFor({ timeout: 20000 })
  if (mode === 'edit') {
    await page.getByRole('button', { name: 'Edit' }).click({ timeout: 15000 })
  }
  await page
    .waitForFunction(() => document.querySelector('[data-testid="collab-status"]')?.getAttribute('data-status') === 'connected', null, {
      timeout: 10000,
    })
    .catch(() => {
      throw new Error('collab-status never connected (10s)')
    })
}

/** 썸네일 클릭으로 슬라이드 이동. 근거: ASIDE[role=navigation][aria-label=Slides]
 *  하위 BUTTON[aria-label="Go to slide N"] (scratch DOM 덤프 2026-10-15). */
export async function gotoSlide(page: Page, n: number): Promise<void> {
  await page.getByRole('button', { name: `Go to slide ${n}` }).click({ timeout: 10000 })
  await page.waitForTimeout(1200)
}

/** 도형 한 번 클릭 (선택). lib 핸들러 확실 발화를 위해 dispatch를 쓴다. */
export async function selectShape(page: Page, shapes: ShapeLocator, shapeName: string): Promise<void> {
  const id = await shapes.idFor(shapeName)
  await page.evaluate((eid) => {
    const el = document.querySelector(`[data-element-id="${CSS.escape(eid)}"]`)
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }, id)
  await page.waitForTimeout(800)
}

/** 도형 더블클릭 → 전체선택 → 입력 → Escape. 실제 키보드로 입력한다. */
export async function editShapeText(page: Page, shapes: ShapeLocator, shapeName: string, text: string): Promise<void> {
  const id = await shapes.idFor(shapeName)
  await page.evaluate((eid) => {
    const el = document.querySelector(`[data-element-id="${CSS.escape(eid)}"]`)
    el?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  }, id)
  await page.waitForFunction(
    () => document.querySelectorAll('textarea, [contenteditable="true"]').length > 0,
    null,
    { timeout: 8000 },
  )
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type(text)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(800)
}
