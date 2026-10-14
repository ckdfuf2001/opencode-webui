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
  private getSession: (() => Promise<ResumeOutcome>) | null = null
  private onTerminalError: ((kind: 'external_change' | 'epoch_mismatch') => void) | null = null

  readonly url: string

  constructor(url: string, user: YCollabUser) {
    this.url = url
    this.awareness.setLocalState({ userName: user.name, userColor: user.color })
    // 리스너는 여기서 1회만. connect()/reconnect()에서는 소켓만 갈아낀다.
    this.doc.on('update', this.onDocUpdate)
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
      this.send(encoding.toUint8Array(a))
    }
    ws.onmessage = (evt) => {
      const data = toBytes((evt as MessageEvent).data)
      if (!data) return
      const d = decoding.createDecoder(data)
      const type = decoding.readVarUint(d)
      if (type === 0) {
        const e = encoding.createEncoder()
        encoding.writeVarUint(e, 0)
        const t = syncProtocol.readSyncMessage(d, e, this.doc, this)
        if (encoding.length(e) > 1) this.send(encoding.toUint8Array(e))
        if (t === syncProtocol.messageYjsSyncStep2 && !this.synced) {
          this.synced = true
          this.retry = 0
          this.setStatus('connected')
        }
      } else if (type === 1) {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(d), this)
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

  /** 화면 복귀·온라인 즉시 재시도. */
  poke(): void {
    if (this.disposed) return
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.retry = 0
    if (!this.ws) void this.recover()
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

  setUser(user: YCollabUser): void {
    this.awareness.setLocalState({ userName: user.name, userColor: user.color })
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
    try {
      this.doc.off('update', this.onDocUpdate)
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
    try {
      this.doc.destroy()
    } catch {
      // 무시
    }
    this.listeners.clear()
  }
}

const PALETTE = ['#e11d48', '#2563eb', '#059669', '#d97706', '#7c3aed', '#db2777', '#0891b2', '#65a30d']

export function colorForName(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return PALETTE[h % PALETTE.length]!
}

export interface CollabViewState {
  session: YCollabSession
  roomId: string
  role: 'owner' | 'collaborator'
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
    authorName: string
    isDecrypted: boolean
    writeBackDebounceMs: number
    onWriteBack: (bytes: Uint8Array) => void
  },
): CollaborationConfig | undefined {
  if (!state || !opts.editing || opts.isDecrypted) return undefined
  const userColor = colorForName(opts.authorName)
  return {
    roomId: state.roomId,
    // externalSession을 쓰므로 무시된다.
    serverUrl: '',
    externalSession: state.session.toExternal() as unknown as CollaborationConfig['externalSession'],
    userName: opts.authorName,
    userColor,
    role: state.role,
    writeBackDebounceMs: opts.writeBackDebounceMs,
    onWriteBack: (bytes: Uint8Array) => {
      opts.onWriteBack(bytes)
    },
  }
}
