import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import type { CollaborationConfig } from 'pptx-react-viewer'

export type YCollabStatus = 'connecting' | 'connected' | 'disconnected' | 'error'

export interface YCollabUser {
  name: string
  color: string
}

/** 서버 connMode/participants가 읽는 awareness app 필드의 모드. */
export type YCollabMode = 'view' | 'edit'

export interface YCollabAppState {
  id: string | number
  name: string
  color: string
  mode: YCollabMode
  device?: YCollabDevice
}

export interface YCollabSessionResult {
  roomId: string
  role: 'host' | 'guest' | 'resume'
  epoch: string
  lastHash: string
}

export type ResumeOutcome =
  | { kind: 'ok'; info: YCollabSessionResult }
  | { kind: 'terminal'; terminal: 'external_change' | 'epoch_mismatch' }
  | { kind: 'retry' }

/** 서버 meta push (type 100) — lib은 모르는 서버→클라이언트 전용 채널. */
export interface YCollabMeta {
  ownerClientId: number | null
  lastHash: string
  epoch: string
  externalChanged: boolean
  aiBlockedAt: number | null
}

/** Y.Doc 변경 집계 (작성자 판별용). writers가 비면 삭제-only일 수 있다. */
export interface CollabActivity {
  at: number
  writers: number[]
}

/** app.device — usePeers의 모바일/데스크톱 구분용. */
export type YCollabDevice = 'mobile' | 'desktop'

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return null
}

/**
 * 백엔드 릴레이(/api/collab/:room, y-websocket 호환)에 붙는 외부 세션.
 * Y.Doc·awareness를 호스트가 소유하고, viewer에는 빌려준다
 * (externalSession — viewer는 detach만 하고 destroy하지 않는다).
 *
 * P0-1 규칙:
 * - open 즉시 syncStep1을 보낸다 (서버 상태 수신용). step2를 받아야 synced.
 * - Y.Doc 리스너는 생성 시 1회만 등록한다 (재연결 중복 방지).
 * - 받은 update는 origin 표시로 재전송하지 않는다 (echo storm 방지).
 * - 재연결해도 같은 Y.Doc을 쓴다 (리마운트·재생성 금지).
 */
export class YCollabSession {
  readonly doc = new Y.Doc()
  readonly awareness = new awarenessProtocol.Awareness(this.doc)
  status: YCollabStatus = 'connecting'
  synced = false
  /** 서버 lastHash/세션에서 갱신하는 known 해시 (resume·저장에 사용). */
  knownHash: string | null = null

  private ws: WebSocket | null = null
  private listeners = new Set<() => void>()
  private disposed = false
  private retry = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private syncWatchdog: ReturnType<typeof setTimeout> | null = null
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private getSession: (() => Promise<ResumeOutcome>) | null = null
  private onTerminalError: ((kind: 'external_change' | 'epoch_mismatch') => void) | null = null
  /** awareness app.id로 쓰는 안정 식별자 (E2E의 u-ada 등). 없으면 doc.clientID. */
  private readonly userId: string | number
  /** 마지막 수신 시각 (half-open 감지용, D). */
  lastRxAt: number = Date.now()
  /** 마지막 수신 meta (없으면 null). */
  lastMeta: YCollabMeta | null = null
  private metaListeners = new Set<(meta: YCollabMeta) => void>()
  /** clientId → 마지막 편집 시각 (step2 초기동기화 제외, 3.3). */
  readonly lastEditAt = new Map<number, number>()
  private activityListeners = new Set<(a: CollabActivity) => void>()
  private applyingKind: number | null = null

  readonly url: string

  constructor(url: string, user: YCollabUser, opts?: { mode?: YCollabMode; userId?: string; device?: YCollabDevice }) {
    this.url = url
    this.userId = opts?.userId ?? this.doc.clientID
    const mode = opts?.mode ?? 'edit'
    // 서버가 읽는 app 필드(id/name/color/mode)를 처음부터 publish한다.
    // presence 필드는 viewer lib이 빌려서 쓰므로 건드리지 않는다.
    this.awareness.setLocalState({
      userName: user.name,
      userColor: user.color,
      app: {
        id: this.userId,
        name: user.name,
        color: user.color,
        mode,
        device: opts?.device ?? 'desktop',
      } satisfies YCollabAppState,
    })
    // 리스너는 여기서 1회만. connect()/reconnect()에서는 소켓만 갈아낀다.
    this.doc.on('update', this.onDocUpdate)
    this.doc.on('update', this.onDocActivity)
    this.awareness.on('update', this.onAwarenessUpdate)
  }

  get clientId(): number {
    return this.doc.clientID
  }

  /** 재연결 루프용 콜백. */
  setRecovery(hooks: {
    getSession: () => Promise<ResumeOutcome>
    onTerminalError: (kind: 'external_change' | 'epoch_mismatch') => void
  }): void {
    this.getSession = hooks.getSession
    this.onTerminalError = hooks.onTerminalError
  }

  connect(): void {
    if (this.ws || this.disposed) return
    this.openSocket()
  }

  /** 같은 doc으로 WS만 다시 연다. synced는 step2를 받아야 다시 true. */
  reconnect(): void {
    if (this.disposed) return
    try {
      this.ws?.close()
    } catch {
      // 무시
    }
    this.ws = null
    this.synced = false
    this.emit()
    this.openSocket()
  }

  private openSocket(): void {
    if (this.disposed) return
    const ws = new WebSocket(this.url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    // connect 블랙홀(loopback SYN 무응답) 대비: onopen 없이 5초가 가면
    // 소켓을 버리고 재시도한다. 실패-빠름(EACCES)은 onerror 경로로 간다.
    if (this.connectTimer) clearTimeout(this.connectTimer)
    this.connectTimer = setTimeout(() => {
      if (this.disposed || this.ws !== ws || ws.readyState === WebSocket.OPEN) return
      try {
        ws.close()
      } catch {
        // 무시
      }
      // onclose가 뒤따르면 정상 경로로 재시도된다. 안 뒤따르면 직접 예약.
      if (!this.disposed && this.ws === ws) {
        this.ws = null
        this.scheduleReconnect()
      }
    }, 5000)
    // handshake 감시: step2 없이 오래 가면 이번 시도는 실패로 친다.
    if (this.syncWatchdog) clearTimeout(this.syncWatchdog)
    this.syncWatchdog = setTimeout(() => {
      if (!this.disposed && !this.synced && this.ws === ws) {
        try {
          ws.close()
        } catch {
          // 무시
        }
        this.scheduleReconnect()
      }
    }, 15000)

    ws.onopen = () => {
      this.retry = 0
      // 서버 상태를 요청한다 (늦게 온 쪽이 기존 내용을 받는 유일한 경로).
      const s = encoding.createEncoder()
      encoding.writeVarUint(s, 0)
      syncProtocol.writeSyncStep1(s, this.doc)
      this.send(encoding.toUint8Array(s))
      // awareness 초기 publish (서버가 clientID를 알아야 owner 판정이 된다).
      const a = encoding.createEncoder()
      encoding.writeVarUint(a, 1)
      encoding.writeVarUint8Array(
        a,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.awareness.clientID]),
      )
      const ab = encoding.toUint8Array(a)
      this.send(ab)
    }
    ws.onmessage = (evt) => {
      const data = toBytes((evt as MessageEvent).data)
      if (!data) return
      // D: 모든 수신(type 99 keepalive 포함)이 lastRxAt을 갱신한다.
      this.lastRxAt = Date.now()
      const d = decoding.createDecoder(data)
      const type = decoding.readVarUint(d)
      if (type === 0) {
        const e = encoding.createEncoder()
        encoding.writeVarUint(e, 0)
        // 3.3: 뒤따르는 doc update의 종류를 구분한다 (step2 초기동기화 제외용).
        this.applyingKind = decoding.peekVarUint(d)
        let t: number
        try {
          t = syncProtocol.readSyncMessage(d, e, this.doc, this)
        } finally {
          this.applyingKind = null
        }
        if (encoding.length(e) > 1) this.send(encoding.toUint8Array(e))
        if (t === syncProtocol.messageYjsSyncStep2 && !this.synced) {
          this.synced = true
          this.retry = 0
          this.setStatus('connected')
        }
      } else if (type === 1) {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(d), this)
      } else if (type === 100) {
        // 서버 meta push (owner/lastHash/epoch/externalChanged/aiBlockedAt).
        try {
          const raw = decoding.readVarUint8Array(d)
          const meta = JSON.parse(new TextDecoder().decode(raw)) as YCollabMeta
          this.lastMeta = meta
          this.metaListeners.forEach((l) => {
            try {
              l(meta)
            } catch {
              // 무시
            }
          })
        } catch {
          // 무시 (구서버 호환)
        }
      }
    }
    ws.onclose = (evt) => {
      if (this.ws !== ws) return
      this.ws = null
      if (this.disposed) return
      const e = evt as CloseEvent
      if (e && (e as { code?: number }).code === 1008) {
        // room 없음 — 곧바로 session 재등록 경로로 간다.
        this.retry = 0
        void this.recover()
        return
      }
      this.setStatus('disconnected')
      this.scheduleReconnect()
    }
    ws.onerror = () => {
      if (this.disposed || this.status !== 'connecting') return
      // onclose가 뒤따르지 않는 구현도 있으므로 소켓을 직접 정리한다.
      // onclose가 뒤따르면 가드(this.ws !== ws)로 no-op가 된다.
      if (this.ws === ws) {
        try {
          ws.close()
        } catch {
          // 무시
        }
        this.ws = null
      }
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.reconnectTimer) return
    // 0.5 → 1 → 2 → … → 최대 10초 + jitter.
    const delay = Math.min(500 * 2 ** this.retry, 10000) + Math.random() * 300
    this.retry += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.disposed) return
      void this.recover()
    }, delay)
  }

  /** 화면 복귀·온라인 즉시 재시도. D: 소켓이 없거나 25초 무수신이면 재연결한다. */
  poke(): void {
    if (this.disposed) return
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.retry = 0
    if (!this.ws || Date.now() - this.lastRxAt > 25000) {
      this.reconnect()
    }
  }

  private async recover(): Promise<void> {
    if (this.disposed) return
    // 1) session 재등록 (resume). getSession 없으면 WS만 다시 연다.
    if (this.getSession) {
      let outcome: ResumeOutcome
      try {
        outcome = await this.getSession()
      } catch {
        if (!this.disposed) this.scheduleReconnect()
        return
      }
      if (this.disposed) return
      if (outcome.kind === 'terminal') {
        this.setStatus('error')
        try {
          this.onTerminalError?.(outcome.terminal)
        } catch {
          // 무시
        }
        return
      }
      if (outcome.kind === 'retry') {
        this.scheduleReconnect()
        return
      }
      if (outcome.info.lastHash) this.knownHash = outcome.info.lastHash
    }
    // 2) 같은 doc으로 WS 재오픈 (viewer 리마운트 없음).
    if (!this.ws && !this.disposed) {
      this.synced = false
      this.emit()
      this.openSocket()
    }
  }

  private onDocUpdate = (update: Uint8Array, origin: unknown): void => {
    if (origin === this) return // 받은 update를 다시 보내지 않는다
    const e = encoding.createEncoder()
    encoding.writeVarUint(e, 0)
    syncProtocol.writeUpdate(e, update)
    this.send(encoding.toUint8Array(e))
  }

  /**
   * 3.3 작성자 판별. update 안의 struct client ID로 누가 편집했는지 집계한다.
   * - step2(초기 전체 동기화)는 과거 기록이라 제외한다.
   * - 내 로컬 편집(origin !== this)은 항상 집계한다.
   * - 삭제-only는 from/to에 잡히지 않는다. writers가 비면 수신 측에서
   *   awareness 최근 갱신자로 폴백한다 (정확도 한계, 문서화됨).
   */
  private onDocActivity = (update: Uint8Array, origin: unknown): void => {
    if (this.disposed) return
    if (origin === this && this.applyingKind !== syncProtocol.messageYjsUpdate) return
    const writers: number[] = []
    try {
      const { from, to } = Y.parseUpdateMeta(update)
      for (const [client, clock] of to) {
        if (clock > (from.get(client) ?? 0)) writers.push(client)
      }
    } catch {
      // 파싱 실패는 writers 비움으로 처리 (폴백 경로).
    }
    const now = Date.now()
    for (const w of writers) this.lastEditAt.set(w, now)
    const activity: CollabActivity = { at: now, writers }
    this.activityListeners.forEach((l) => {
      try {
        l(activity)
      } catch {
        // 무시
      }
    })
  }

  /** Y.Doc 변경(작성자 집계) 구독. */
  onActivity(listener: (a: CollabActivity) => void): () => void {
    this.activityListeners.add(listener)
    return () => {
      this.activityListeners.delete(listener)
    }
  }

  private onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ): void => {
    if (origin === this) return
    const e = encoding.createEncoder()
    encoding.writeVarUint(e, 1)
    encoding.writeVarUint8Array(
      e,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...added, ...updated, ...removed]),
    )
    this.send(encoding.toUint8Array(e))
  }

  private send(data: Uint8Array): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(data)
      } catch {
        // 다음 기회에 재전송된다 (Yjs는 상태를 다시 요청한다)
      }
    }
  }

  private setStatus(s: YCollabStatus): void {
    if (this.status === s) return
    this.status = s
    this.emit()
  }

  private emit(): void {
    this.listeners.forEach((l) => {
      try {
        l()
      } catch {
        // 무시
      }
    })
  }

  getSnapshot(): { status: YCollabStatus; synced: boolean } {
    return { status: this.status, synced: this.synced }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** 서버 meta push 구독 (owner/외부변경/AI차단 즉시 반영용). */
  onMeta(listener: (meta: YCollabMeta) => void): () => void {
    this.metaListeners.add(listener)
    return () => {
      this.metaListeners.delete(listener)
    }
  }

  setUser(user: YCollabUser): void {
    // 전체 setLocalState는 lib의 presence를 지우므로 필드 병합으로 갱신한다.
    const prev = (this.awareness.getLocalState() ?? {}) as Record<string, unknown>
    const prevApp = (prev.app ?? {}) as Record<string, unknown>
    this.awareness.setLocalState({
      ...prev,
      userName: user.name,
      userColor: user.color,
      app: { ...prevApp, id: this.userId, name: user.name, color: user.color },
    })
  }

  /** view/edit 전환. app.mode 갱신이 서버 owner 재선출을 유발한다. */
  setMode(mode: YCollabMode): void {
    const prev = (this.awareness.getLocalState() ?? {}) as Record<string, unknown>
    const prevApp = (prev.app ?? {}) as Record<string, unknown>
    this.awareness.setLocalStateField('app', {
      ...prevApp,
      id: this.userId,
      mode,
    })
    // setLocalStateField는 awareness update를 일으켜 onAwarenessUpdate가 publish한다.
  }

  /** viewer에 빌려줄 externalSession 객체. */
  toExternal(): {
    doc: Y.Doc
    awareness: awarenessProtocol.Awareness
    getSnapshot: () => { status: YCollabStatus; synced: boolean }
    subscribe: (listener: () => void) => () => void
  } {
    return {
      doc: this.doc,
      awareness: this.awareness,
      getSnapshot: () => this.getSnapshot(),
      subscribe: (l: () => void) => this.subscribe(l),
    }
  }

  destroy(): void {
    this.disposed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.syncWatchdog) {
      clearTimeout(this.syncWatchdog)
      this.syncWatchdog = null
    }
    if (this.connectTimer) {
      clearTimeout(this.connectTimer)
      this.connectTimer = null
    }
    try {
      this.doc.off('update', this.onDocUpdate)
    } catch {
      // 무시
    }
    try {
      this.doc.off('update', this.onDocActivity)
    } catch {
      // 무시
    }
    try {
      this.awareness.off('update', this.onAwarenessUpdate)
    } catch {
      // 무시
    }
    try {
      this.ws?.close()
    } catch {
      // 무시
    }
    this.ws = null
    this.metaListeners.clear()
    this.activityListeners.clear()
    this.lastEditAt.clear()
    try {
      this.doc.destroy()
    } catch {
      // 무시
    }
    this.listeners.clear()
  }
}

const PALETTE = ['#e11d48', '#2563eb', '#059669', '#d97706', '#7c3aed', '#db2777', '#0891b2', '#65a30d']

/** 참가자 색 팔레트 (신원 생성 시 1회 선택용 — 이름 해시 금지). */
export const COLLAB_PALETTE: readonly string[] = PALETTE

export function colorForName(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]!
}

export interface CollabViewState {
  session: YCollabSession
  roomId: string
  role: 'owner' | 'collaborator' | 'viewer'
  /** 'create'면 빈 방에 seed, 'join'이면 방 상태를 adopt(ROOM 승리). */
  intent: 'create' | 'join'
}

/**
 * viewer에 넘길 collaboration 설정 (pure — T6 검증용).
 * role이 바뀌어 리마운트돼도 같은 session/doc을 빌려준다.
 * 복호화 문서는 제외한다 (복호 바이트를 디스크에 쓸 수 없음).
 */
export function buildCollaborationConfig(
  state: CollabViewState | null,
  opts: {
    editing: boolean
    viewing: boolean
    user: { name: string; color: string }
    isDecrypted: boolean
    writeBackDebounceMs: number
    onWriteBack: (bytes: Uint8Array) => void
  },
): CollaborationConfig | undefined {
  if (!state || opts.isDecrypted) return undefined
  if (!opts.editing && !opts.viewing) return undefined
  return {
    roomId: state.roomId,
    // externalSession을 쓰므로 무시된다.
    serverUrl: '',
    externalSession: state.session.toExternal() as unknown as CollaborationConfig['externalSession'],
    userName: opts.user.name,
    userColor: opts.user.color,
    role: state.role,
    sessionIntent: state.intent,
    writeBackDebounceMs: opts.writeBackDebounceMs,
    onWriteBack: (bytes: Uint8Array) => {
      opts.onWriteBack(bytes)
    },
  }
}
