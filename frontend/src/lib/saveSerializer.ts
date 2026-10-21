// M27/M28 1-1′: 저장 직렬화 순수 모듈.
//
// - lib 이 flush(즉시)와 debounce(2.5초) 두 경로로 저장 요청을 보낼 수 있고, 각자 serialize
//   한 뒤 호출한다. 동시에 나가면 "먼저 시작한 저장이 나중에 끝나" 디스크 최종본이 옛 내용이 되는
//   역전이 생긴다(큰 덱은 serialize 에 수백 ms~수 초 걸린다).
// - 이 모듈은 **저장 요청끼리의 역전**을 막는다(in-flight 1개 + latest-wins).
//   serialize **시점**의 역전은 `gen`(serialize 시작 시점 단조 증가 번호) 으로 막는다.
// - 실패(skip 포함)는 조용히 넘기지 않는다: skip 은 재시도하지 않고, 실패는 재시도 가능 여부에
//   따라 한정된 횟수만 시도한 뒤 `writeback-failed` 로 알린다.
// - 바이트는 저장 요청 시점의 것만 보관하고, 보관 기간은 저장 완료/실패 확정까지로 한정한다(D27).
//   실패한 바이트 1개만 보관한다(내 사본 다운로드용, 상한 1).

export type SaveSkipReason =
  | 'owner_lost'
  | 'session_changed'
  | 'stale_gen'
  | 'empty_bytes'
  | 'nothing_to_save'
  | 'not_owner'
  | 'no_path'
  | 'denied'
  | 'unknown'

/** 실제 저장 결과. throw 하지 않는 반환형 계약(앱 persistBytes 와 동일 계약). */
export type SaveOutcome =
  | { ok: true }
  | { ok: false; reason: string; retryable: boolean }
  | { skipped: SaveSkipReason | string }

export type SaveSerializerEvent =
  | { evt: 'writeback.queued'; reqSeq: number; bytes: number }
  | { evt: 'save.start'; saveSeq: number; covers: number[]; bytes: number }
  | { evt: 'save.done'; saveSeq: number; bytes: number }
  | { evt: 'save.error'; saveSeq: number; bytes: number; reason: string; retryable: boolean }
  | { evt: 'save.skip'; saveSeq: number; reason: SaveSkipReason | string }
  | { evt: 'writeback-failed'; saveSeq: number; bytes: number; reason: string }

export interface SaveSession {
  path?: string
  roomId?: string
  epoch?: string
}

export interface SaveRequestMeta {
  /** serialize 시작 시점의 단조 증가 번호(1-2 에서 lib 과 연결). 낮으면 버린다. */
  gen?: number
  /** 요청 시점의 세션(파일/방/epoch). 저장 직전에 현재 값과 비교한다. */
  session?: SaveSession
}

export interface SaveSerializerOptions<T> {
  /** 실제 저장. ok=성공, ok:false=실패(retryable 은 재시도 대상), skipped=정상 skip. */
  save: (bytes: T, ctx: { saveSeq: number }) => Promise<SaveOutcome>
  /** 저장 직전에 owner/synced 를 **다시** 확인한다(P0-3). false 면 owner_lost 로 건너뛴다. */
  canSave?: () => boolean
  /** 현재 세션(파일/방/epoch). 대기 중 세션이 바뀌면 저장하지 않는다(P0-2). */
  getSession?: () => SaveSession
  onEvent?: (e: SaveSerializerEvent) => void
  /** 실패 재시도 정책(재시도 가능 실패에만 적용). attempts 회, delayMs 간격. 무한 루프 금지. */
  retry?: { attempts: number; delayMs: number }
}

export interface SaveSerializer<T> {
  /** 저장 요청. 진행 중이면 최신 요청으로 대체한다(latest-wins). */
  request: (bytes: T, meta?: SaveRequestMeta) => Promise<boolean>
  /** 진행 중인 저장(없으면 null). endEditing 이 await 할 대상. */
  readonly pending: Promise<boolean> | null
  /** 디스크에 반영되지 않은 것이 남아 있는지(실패 바이트 포함). */
  readonly dirty: boolean
  /** 마지막 실패 바이트(내 사본 다운로드용). 성공하면 null. */
  readonly failedBytes: T | null
  /** 실패 바이트를 버린다(사용자가 내 사본을 받았을 때). */
  clearFailed: () => void
  /** 언마운트 시 타이머/잔여 요청 정리. */
  dispose: () => void
}

export function createSaveSerializer<T>(opts: SaveSerializerOptions<T>): SaveSerializer<T> {
  const attempts = Math.max(1, opts.retry?.attempts ?? 2)
  const delayMs = Math.max(0, opts.retry?.delayMs ?? 500)
  let inFlight: Promise<boolean> | null = null
  let pendingBytes: T | null = null
  let pendingMeta: SaveRequestMeta | undefined
  let pendingCovers: number[] = []
  let failedBytes: T | null = null
  let reqSeq = 0
  let saveSeq = 0
  let lastSavedGen = -1
  let dirty = false
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const emit = (e: SaveSerializerEvent) => opts.onEvent?.(e)

  const sleep = (ms: number) =>
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => {
        timer = null
        resolve(!disposed)
      }, ms)
    })

  const sameSession = (a?: SaveSession, b?: SaveSession): boolean => {
    if (!a || !b) return true
    if (a.path !== undefined && b.path !== undefined && a.path !== b.path) return false
    if (a.roomId !== undefined && b.roomId !== undefined && a.roomId !== b.roomId) return false
    if (a.epoch !== undefined && b.epoch !== undefined && a.epoch !== b.epoch) return false
    return true
  }

  async function runOnce(bytes: T, covers: number[], meta?: SaveRequestMeta): Promise<boolean> {
    const s = ++saveSeq
    // P0-2 (b): serialize 시작 시점의 gen 이 마지막 저장보다 낮으면(옛 직렬화) 버린다.
    const g = meta?.gen
    if (typeof g === 'number' && g < lastSavedGen) {
      emit({ evt: 'save.skip', saveSeq: s, reason: 'stale_gen' })
      return true
    }
    // P0-2: 파일/방/epoch 가 바뀌었으면 이 바이트는 남의 파일로 나가지 않는다.
    if (opts.getSession && !sameSession(meta?.session, opts.getSession())) {
      emit({ evt: 'save.skip', saveSeq: s, reason: 'session_changed' })
      return false
    }
    // P0-3: owner 가 바뀐 뒤 대기열에 있던 저장은 내보내지 않는다.
    // 새 owner 가 같은 Y.Doc 상태를 저장하므로 유실이 아니다.
    if (opts.canSave && !opts.canSave()) {
      emit({ evt: 'save.skip', saveSeq: s, reason: 'owner_lost' })
      return false
    }
    emit({ evt: 'save.start', saveSeq: s, covers, bytes: sizeOf(bytes) })
    let outcome: SaveOutcome = { ok: false, reason: 'unknown', retryable: false }
    for (let i = 0; i < attempts; i++) {
      if (i > 0) {
        const alive = await sleep(delayMs)
        if (!alive) return false
      }
      try {
        outcome = await opts.save(bytes, { saveSeq: s })
      } catch (e) {
        // throw 는 실패로 간주(재시도 가능: 네트워크성).
        outcome = { ok: false, reason: String((e as Error)?.message ?? e), retryable: true }
      }
      if ('skipped' in outcome) {
        // 정상 skip: 재시도하지 않는다(같은 바이트로 다시 보내도 결과가 같다).
        emit({ evt: 'save.skip', saveSeq: s, reason: outcome.skipped })
        return false
      }
      if (outcome.ok) break
      if (!outcome.retryable) break
    }
    if (outcome.ok) {
      if (typeof g === 'number') lastSavedGen = Math.max(lastSavedGen, g)
      failedBytes = null
      dirty = pendingBytes !== null
      emit({ evt: 'save.done', saveSeq: s, bytes: sizeOf(bytes) })
      return true
    }
    if ('skipped' in outcome) return false
    // P0-1/P0-4: 실패는 알리고, 실패 바이트는 보관한다(dirty 유지 → 내 사본 다운로드).
    failedBytes = bytes
    dirty = true
    emit({
      evt: 'save.error',
      saveSeq: s,
      bytes: sizeOf(bytes),
      reason: outcome.reason,
      retryable: outcome.retryable,
    })
    emit({ evt: 'writeback-failed', saveSeq: s, bytes: sizeOf(bytes), reason: outcome.reason })
    return false
  }

  async function loop(): Promise<boolean> {
    let allOk = true
    for (;;) {
      if (disposed) break
      if (pendingBytes === null) break
      const bytes = pendingBytes
      const meta = pendingMeta
      const covers = pendingCovers
      pendingBytes = null
      pendingMeta = undefined
      pendingCovers = []
      const ok = await runOnce(bytes, covers, meta)
      if (!ok) allOk = false
    }
    dirty = pendingBytes !== null || failedBytes !== null
    return allOk
  }

  function request(bytes: T, meta?: SaveRequestMeta): Promise<boolean> {
    if (disposed) return Promise.resolve(false)
    const r = ++reqSeq
    pendingBytes = bytes
    pendingMeta = meta
    pendingCovers = [...pendingCovers, r]
    dirty = true
    if (inFlight) {
      emit({ evt: 'writeback.queued', reqSeq: r, bytes: sizeOf(bytes) })
      return inFlight
    }
    const p = loop().finally(() => {
      inFlight = null
      dirty = pendingBytes !== null || failedBytes !== null
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
    get failedBytes() {
      return failedBytes
    },
    clearFailed() {
      failedBytes = null
      dirty = pendingBytes !== null
    },
    dispose() {
      disposed = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      pendingBytes = null
      pendingMeta = undefined
      pendingCovers = []
    },
  }
}

function sizeOf(bytes: unknown): number {
  if (bytes instanceof Uint8Array) return bytes.byteLength
  if (Array.isArray(bytes)) return bytes.length
  return 0
}
