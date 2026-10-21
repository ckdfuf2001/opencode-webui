// M27 1-1: 저장 직렬화 순수 모듈.
// - lib 이 flush(즉시)와 debounce(2.5초) 두 경로로 저장 요청을 보낼 수 있고, 각자 serialize
//   한 뒤 호출한다. 동시에 나가면 "먼저 시작한 저장이 나중에 끝나" 디스크 최종본이 옛 내용이 되는
//   역전이 생긴다(큰 덱은 serialize 에 수백 ms~수 초 걸린다).
// - 이 모듈은 **저장 요청끼리의 역전**을 막는다(in-flight 1개 + latest-wins).
//   serialize **시점**의 역전(P0-2)은 lib 이 gen 을 넘겨주면 함께 막을 수 있다(아래 gen 지원).
// - 바이트는 저장 요청이 들어온 시점의 것만 보관하고, 보관 기간은 저장 완료까지로 한정한다(D27).

export type SaveSerializerEvent =
  | { evt: 'writeback.queued'; reqSeq: number; bytes: number }
  | { evt: 'save.start'; saveSeq: number; covers: number[]; bytes: number }
  | { evt: 'save.done'; saveSeq: number; bytes: number }
  | { evt: 'save.error'; saveSeq: number; bytes: number; reason: string }
  | { evt: 'save.skip'; saveSeq: number; reason: 'owner_lost' }
  | { evt: 'writeback-failed'; saveSeq: number; bytes: number; reason: string }

export interface SaveSerializerOptions<T> {
  /** 실제 저장. true = 성공, false = 실패(throw 하지 않는 반환형 계약). */
  save: (bytes: T, ctx: { saveSeq: number }) => Promise<boolean>
  /** 저장 직전에 owner/synced 를 **다시** 확인한다(P0-3). false 면 owner_lost 로 건너뛴다. */
  canSave?: () => boolean
  /** 직렬화 시작 시점의 단조 증가 번호(선택). 낮으면 버린다(P0-2 (b)). */
  gen?: (bytes: T) => number | undefined
  onEvent?: (e: SaveSerializerEvent) => void
  /** 실패 재시도 정책: attempts 회, delayMs 간격. 무한 루프 금지(기본 1회/500ms). */
  retry?: { attempts: number; delayMs: number }
}

export interface SaveSerializer<T> {
  /** 저장 요청. 진행 중이면 최신 요청으로 대체한다(latest-wins). */
  request: (bytes: T) => Promise<boolean>
  /** 진행 중인 저장(없으면 null). endEditing 이 await 할 대상. */
  readonly pending: Promise<boolean> | null
  /** 마지막 저장 완료 후 남은 미저장 요청이 있는지(P0-1: 실패로 유실되지 않았는지). */
  readonly dirty: boolean
}

export function createSaveSerializer<T>(opts: SaveSerializerOptions<T>): SaveSerializer<T> {
  const attempts = Math.max(1, opts.retry?.attempts ?? 2)
  const delayMs = Math.max(0, opts.retry?.delayMs ?? 500)
  let inFlight: Promise<boolean> | null = null
  let pendingBytes: T | null = null
  let pendingCovers: number[] = []
  let reqSeq = 0
  let saveSeq = 0
  let lastSavedGen = -1
  let dirty = false

  const emit = (e: SaveSerializerEvent) => opts.onEvent?.(e)

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

  async function runOnce(bytes: T, covers: number[]): Promise<boolean> {
    const s = ++saveSeq
    // P0-2 (b): serialize 시작 시점의 gen 이 마지막 저장보다 낮으면(옛 직렬화) 버린다.
    const g = opts.gen?.(bytes)
    if (typeof g === 'number' && g < lastSavedGen) {
      emit({ evt: 'save.skip', saveSeq: s, reason: 'owner_lost' })
      return true
    }
    if (opts.canSave && !opts.canSave()) {
      // P0-3: owner 가 바뀐 뒤 대기열에 있던 저장은 내보내지 않는다.
      // 새 owner 가 같은 Y.Doc 상태를 저장하므로 유실이 아니다.
      emit({ evt: 'save.skip', saveSeq: s, reason: 'owner_lost' })
      return false
    }
    emit({ evt: 'save.start', saveSeq: s, covers, bytes: sizeOf(bytes) })
    let ok = false
    let reason = 'unknown'
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await sleep(delayMs)
      try {
        ok = await opts.save(bytes, { saveSeq: s })
        reason = ok ? 'ok' : 'save_failed'
        if (ok) break
      } catch (e) {
        ok = false
        reason = String((e as Error)?.message ?? e)
      }
    }
    if (ok) {
      if (typeof g === 'number') lastSavedGen = Math.max(lastSavedGen, g)
      emit({ evt: 'save.done', saveSeq: s, bytes: sizeOf(bytes) })
      return true
    }
    emit({ evt: 'save.error', saveSeq: s, bytes: sizeOf(bytes), reason })
    // P0-1: 실패를 알리고, "내 사본"을 받을 수 있게 신호를 보낸다(3-3).
    emit({ evt: 'writeback-failed', saveSeq: s, bytes: sizeOf(bytes), reason })
    return false
  }

  async function loop(): Promise<boolean> {
    let allOk = true
    for (;;) {
      if (pendingBytes === null) break
      const bytes = pendingBytes
      const covers = pendingCovers
      pendingBytes = null
      pendingCovers = []
      const ok = await runOnce(bytes, covers)
      if (!ok) {
        allOk = false
        // P0-1: 실패해도 **최신 요청은 버리지 않는다**. 다음 요청이 오면 함께 저장된다.
        // (실패한 저장은 재시도 attempts 회 이미 소모되었으므로 무한 루프가 아니다.)
      }
    }
    dirty = pendingBytes !== null
    return allOk
  }

  function request(bytes: T): Promise<boolean> {
    const r = ++reqSeq
    pendingBytes = bytes
    pendingCovers = [...pendingCovers, r]
    dirty = true
    if (inFlight) {
      emit({ evt: 'writeback.queued', reqSeq: r, bytes: sizeOf(bytes) })
      return inFlight
    }
    const p = loop().finally(() => {
      inFlight = null
      dirty = pendingBytes !== null
    })
    inFlight = p
    return p
  }

  return {
    request,
    get pending() {
      return inFlight
    },
    get dirty() {
      return dirty
    },
  }
}

function sizeOf(bytes: unknown): number {
  if (bytes instanceof Uint8Array) return bytes.byteLength
  if (Array.isArray(bytes)) return bytes.length
  return 0
}
