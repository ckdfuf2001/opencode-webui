// M27/M28/M29 1-1″: 저장 직렬화 순수 모듈.
//
// - lib 이 flush(즉시)와 debounce(2.5초) 두 경로로 저장 요청을 보낼 수 있고, 각자 serialize
//   한 뒤 호출한다. 동시에 나가면 "먼저 시작한 저장이 나중에 끝나" 디스크 최종본이 옛 내용이 되는
//   역전이 생긴다(큰 덱은 serialize 에 수백 ms~수 초 걸린다).
// - 이 모듈은 **저장 요청끼리의 역전**을 막는다(in-flight 1개 + latest-wins).
//   serialize **시점**의 역전은 `gen`(serialize 시작 시점 단조 증가 번호) 으로 막는다.
// - 실패(skip 포함)는 조용히 넘기지 않는다: skip 은 재시도하지 않고, 실패는 재시도 가능 여부에
//   따라 한정된 횟수만 시도한 뒤 `writeback-failed` 로 알린다.
// - M29 P0-2: `dispose()` 는 **재시도 타이머만** 정리한다. 이미 들어온 요청과 언마운트 뒤 도착하는
//   flush 요청은 끝까지 처리한다(drain). 미처리 상태로 조용히 false 를 돌려주는 경로는 0개.
// - M29 P0-3: 세션(경로/epoch) 을 요청에 묶고 저장 직전에 비교한다. epoch 를 못 읽으면 판정을
//   거부한다(fail-closed).
// - 바이트는 저장 요청 시점의 것만 보관하고, 실패한 바이트 1개만 추가로 보관한다(D27, 상한 1).

export type SaveSkipReason =
  | 'owner_lost'
  | 'session_changed'
  | 'stale_gen'
  | 'no_epoch'
  | 'disposed'
  | 'empty_bytes'
  | 'nothing_to_save'
  | 'not_owner'
  | 'no_path'
  | 'denied'
  | 'internal_skip'
  | 'unknown'

/** 실제 저장 결과. throw 하지 않는 반환형 계약(앱 persistBytes 와 동일 계약). */
export type SaveOutcome =
  | { ok: true }
  | { ok: false; reason: string; retryable: boolean }
  | { skipped: SaveSkipReason | string }

/** M29 P0-4: 저장의 최종 결과. skip 과 실패를 구분한다(3-4 endEditing 판정용). */
export type SaveResult = 'saved' | 'skipped' | 'failed'

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
  request: (bytes: T, meta?: SaveRequestMeta) => Promise<SaveResult>
  /** 진행 중인 저장(없으면 null). endEditing 이 await 할 대상. */
  readonly pending: Promise<SaveResult> | null
  /** 디스크에 반영되지 않은 것이 남아 있는지(실패 바이트 포함). */
  readonly dirty: boolean
  /** 마지막 실패 바이트(내 사본 다운로드용). 성공하면 null. */
  readonly failedBytes: T | null
  /** 실패 바이트를 버린다(사용자가 내 사본을 받았을 때). */
  clearFailed: () => void
  /** 언마운트 시 **재시도 타이머만** 정리한다. 대기/진행 중 요청은 drain 된다. */
  dispose: () => void
}

export function createSaveSerializer<T>(opts: SaveSerializerOptions<T>): SaveSerializer<T> {
  const attempts = Math.max(1, opts.retry?.attempts ?? 2)
  const delayMs = Math.max(0, opts.retry?.delayMs ?? 500)
  let inFlight: Promise<SaveResult> | null = null
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

  let disposeWaiter: ((alive: boolean) => void) | null = null

  const sleep = (ms: number) =>
    new Promise<boolean>((resolve) => {
      const done = (alive: boolean) => {
        if (timer) {
          clearTimeout(timer)
          timer = null
        }
        disposeWaiter = null
        resolve(alive)
      }
      disposeWaiter = done
      timer = setTimeout(() => done(!disposed), ms)
    })

  const sameSession = (a?: SaveSession, b?: SaveSession): boolean => {
    if (!a || !b) return true
    if (a.path !== undefined && b.path !== undefined && a.path !== b.path) return false
    if (a.roomId !== undefined && b.roomId !== undefined && a.roomId !== b.roomId) return false
    if (a.epoch !== undefined && b.epoch !== undefined && a.epoch !== b.epoch) return false
    return true
  }

  async function runOnce(
    bytes: T,
    covers: number[],
    meta?: SaveRequestMeta,
  ): Promise<SaveResult> {
    const s = ++saveSeq
    // P0-2 (b): serialize 시작 시점의 gen 이 마지막 저장보다 낮으면(옛 직렬화) 버린다.
    const g = meta?.gen
    if (typeof g === 'number' && g < lastSavedGen) {
      emit({ evt: 'save.skip', saveSeq: s, reason: 'stale_gen' })
      return 'skipped'
    }
    // P0-3 fail-closed: 세션이 붙어 있는데 epoch 를 못 읽으면 판정을 거부한다.
    if (meta?.session && !meta.session.epoch) {
      emit({ evt: 'save.skip', saveSeq: s, reason: 'no_epoch' })
      return 'skipped'
    }
    // P0-2: 파일/방/epoch 가 바뀌었으면 이 바이트는 남의 파일로 나가지 않는다.
    if (opts.getSession && !sameSession(meta?.session, opts.getSession())) {
      emit({ evt: 'save.skip', saveSeq: s, reason: 'session_changed' })
      return 'skipped'
    }
    // P0-3: owner 가 바뀐 뒤 대기열에 있던 저장은 내보내지 않는다.
    // 새 owner 가 같은 Y.Doc 상태를 저장하므로 유실이 아니다.
    if (opts.canSave && !opts.canSave()) {
      emit({ evt: 'save.skip', saveSeq: s, reason: 'owner_lost' })
      return 'skipped'
    }
    emit({ evt: 'save.start', saveSeq: s, covers, bytes: sizeOf(bytes) })
    let outcome: SaveOutcome = { ok: false, reason: 'unknown', retryable: false }
    for (let i = 0; i < attempts; i++) {
      if (i > 0) {
        // M29 P0-2: dispose 는 재시도 타이머만 정리한다. 이 대기 중 dispose 되면
        // 재시도를 중단하되 **조용히 끝내지 않는다**(save.skip 으로 남긴다).
        const alive = await sleep(delayMs)
        if (!alive) {
          emit({ evt: 'save.skip', saveSeq: s, reason: 'disposed' })
          return 'skipped'
        }
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
        return 'skipped'
      }
      if (outcome.ok) break
      if (!outcome.retryable) break
    }
    if (outcome.ok) {
      if (typeof g === 'number') lastSavedGen = Math.max(lastSavedGen, g)
      failedBytes = null
      dirty = pendingBytes !== null
      emit({ evt: 'save.done', saveSeq: s, bytes: sizeOf(bytes) })
      return 'saved'
    }
    if ('skipped' in outcome) return 'skipped'
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
    return 'failed'
  }

  async function loop(): Promise<SaveResult> {
    let result: SaveResult = 'saved'
    for (;;) {
      if (pendingBytes === null) break
      const bytes = pendingBytes
      const meta = pendingMeta
      const covers = pendingCovers
      pendingBytes = null
      pendingMeta = undefined
      pendingCovers = []
      const r = await runOnce(bytes, covers, meta)
      if (r === 'failed') result = 'failed'
      else if (r === 'skipped' && result === 'saved') result = 'skipped'
    }
    dirty = pendingBytes !== null || failedBytes !== null
    return result
  }

  function request(bytes: T, meta?: SaveRequestMeta): Promise<SaveResult> {
    // M29 P0-2: dispose 이후 도착한 flush 요청도 처리한다(drain). 버리지 않는다.
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
      // M29 P0-2: 재시도 타이머만 정리한다. 대기/진행 중 요청은 끝까지 처리한다(drain).
      disposed = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      // 재시도 대기 중이었다면 중단하되, 조용히 끝내지 않는다(skip{disposed} 로 남는다).
      if (disposeWaiter) {
        const w = disposeWaiter
        disposeWaiter = null
        w(false)
      }
    },
  }
}

function sizeOf(bytes: unknown): number {
  if (bytes instanceof Uint8Array) return bytes.byteLength
  if (Array.isArray(bytes)) return bytes.length
  return 0
}
