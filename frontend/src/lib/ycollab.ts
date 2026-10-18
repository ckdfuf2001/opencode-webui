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
  /** PPT 전용(슬라이드 번호). E1/E19 계약이라 유지. */
  slide?: number
  /** 공통 위치 표기: "슬라이드 3" / "Sheet1!B3" / "3쪽". 표시 단일 출처. */
  where?: string
}

/**
 * app.where 표기 문자열 단일 출처 (XLSX/DOCX도 같은 패턴을 쓴다).
 * - pptx: "슬라이드 3"
 * - xlsx: "Sheet1!B3"
 * - docx: "3쪽"
 */
export function formatWhere(kind: 'pptx' | 'xlsx' | 'docx', value: string | number): string {
  switch (kind) {
    case 'pptx':
      return `슬라이드 ${value}`
    case 'docx':
      return `${value}쪽`
    case 'xlsx':
      return String(value)
  }
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

/**
 * A1′: lib provider가 transport에 붙는 핸들러 (ooxml-core collab/provider.d.ts:8).
 * 우리가 직접 구현하지 않고, asTransport()가 provider에 넘겨준다.
 */
export interface TransportHandlers {
  /** 채널 사용 가능 (자동 재연결 뒤에도 다시 온다). */
  open: () => void
  /** 채널 종료. transport가 자체 재연결을 결정한다. */
  close: (reason?: string) => void
  /** 바이트 메시지 도착. */
  message: (data: Uint8Array) => void
  /** 치명적이지 않은 실패. */
  error: (error: Error) => void
  /** mesh 전용. */
  peer?: () => void
}

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
  /**
   * A1′: own = 이 세션이 doc/awareness를 소유하고 직접 sync한다 (PPT 기존 경로).
   * transport = lib의 provider가 doc/awareness를 소유하고, 이 세션은 바이트 파이프만 된다.
   */
  readonly mode: 'own' | 'transport'
  readonly doc: Y.Doc
  readonly awareness: awarenessProtocol.Awareness
  status: YCollabStatus = 'connecting'
  synced = false
  /** 서버 lastHash/세션에서 갱신하는 known 해시 (resume·저장에 사용). */
  knownHash: string | null = null

  private ws: WebSocket | null = null
  private listeners = new Set<() => void>()
  private disposed = false
  private retry = 0
  /** Q1: 서버가 4001로 닫았음(방 해체). 재연결 금지 플래그. */
  private resetRequested = false
  private resetListeners = new Set<() => void>()
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
  /** 최근 게시한 신원 (setUser이 app를 다시 채울 때 쓴다). */
  private user!: YCollabUser
  /** G4: republishApp이 되살릴 마지막 app 값/위치. */
  private lastApp: Record<string, unknown> = {}
  private lastWhere: string | null = null
  private lastSlide: number | null = null
  /** own 모드의 현재 모드 (republishApp 복원용). transport에서는 lib이 mode를 대신 갖는다. */
  private ownMode: YCollabMode = 'edit'
  /** A1′ transport 모드: lib provider가 붙는 채널 핸들러. */
  private transportHandlers: TransportHandlers | null = null
  /** open()을 이미 불렀는지 (재연결마다 다시 불러야 provider가 재동기화한다). */
  private transportOpenNotified = false
  /** provider가 disconnect()를 불렀는지. 그 뒤로는 자동 재연결하지 않는다. */
  private disconnectRequested = false

  constructor(url: string, user: YCollabUser, opts?: { mode?: YCollabMode | 'transport'; userId?: string; device?: YCollabDevice; doc?: Y.Doc; awareness?: awarenessProtocol.Awareness }) {
    this.url = url
    this.mode = opts?.mode === 'transport' ? 'transport' : 'own'
    this.doc = opts?.doc ?? new Y.Doc()
    // A1′ C7: transport 모드에서는 lib이 만든 awareness를 그대로 쓴다.
    // 새로 만들면 ycs.awareness !== session.awareness가 되어 소유권이 갈린다.
    this.awareness = opts?.awareness ?? new awarenessProtocol.Awareness(this.doc)
    this.userId = opts?.userId ?? this.doc.clientID
    const mode: YCollabMode = opts?.mode === 'transport' ? 'edit' : opts?.mode ?? 'edit'
    this.user = user
    // 서버가 읽는 app 필드(id/name/color/mode)를 처음부터 publish한다.
    // setLocalState(전체 교체)는 lib의 PRESENCE_FIELD를 지우므로 항상 field 단위로 쓴다.
    // 표시의 단일 출처는 app.* 이며 최상위 userName/userColor는 쓰지 않는다 (v0.13에 제거).
    // transport 모드에서는 lib이 awareness를 소유하므로 app를 건드리지 않는다.
    if (this.mode === 'own') {
      this.awareness.setLocalStateField('app', {
        id: this.userId,
        name: user.name,
        color: user.color,
        mode,
        device: opts?.device ?? 'desktop',
      } as YCollabAppState)
      // 리스너는 여기서 1회만. connect()/reconnect()에서는 소켓만 갈아납니다.
      // transport 모드에서는 provider가 같은 wire를 쓰므로 이 송신기를 등록하면 중복 전송된다.
      this.doc.on('update', this.onDocUpdate)
      this.awareness.on('update', this.onAwarenessUpdate)
    }
    // 작성자 집계는 양 모드에서 필요하다(transport에서 provider가 doc을 갱신하므로).
    this.doc.on('update', this.onDocActivity)
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
      if (this.mode === 'transport') {
        // A1′: syncStep1·awareness 초기 publish는 provider가 보낸다(이중 전송 금지).
        // 채널이 열렸다는 사실만 알린다.
        this.transportOpenNotified = true
        this.transportHandlers?.open()
        return
      }
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
      if (this.mode === 'transport') {
        // A1′: y-protocol 바이트는 손대지 않고 provider에 그대로 넘긴다
        // (0=sync, 1=awareness, 3=queryAwareness). 전용 타입만 여기서 처리한다.
        if (type === 99 || type === 100 || type === 101) {
          this.handleOwnMessage(type, d)
        } else {
          this.transportHandlers?.message(data)
        }
        return
      }
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
          // open 직후 awareness가 서버에 닿지 않은 경우 대비: sync 확정 시점에
          // 스냅샷을 한 번 더 보낸다. 같은 clock이면 서버가 무시하므로 冪等하다.
          const au = encoding.createEncoder()
          encoding.writeVarUint(au, 1)
          encoding.writeVarUint8Array(
            au,
            awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.awareness.clientID]),
          )
          this.send(encoding.toUint8Array(au))
        }
      } else if (type === 1) {
        awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(d), this)
      } else if (type === 100) {
        this.handleOwnMessage(type, d)
      }
    }
    ws.onclose = (evt) => {
      if (this.ws !== ws) return
      this.ws = null
      if (this.disposed) return
      const e = evt as CloseEvent
      const code = (e as { code?: number }).code
      // A1′: provider가 이 채널 종료를 보고한다(재연결은 provider가 결정한다).
      this.transportHandlers?.close(e.reason || `close:${code}`)
      this.transportOpenNotified = false
      if (this.disconnectRequested) {
        // provider가 disconnect()를 명시적으로 호출했다. 자동 재연결 금지.
        this.disconnectRequested = false
        this.setStatus('disconnected')
        return
      }
      if (code === ROOM_RESET_CLOSE_CODE) {
        // Q1: owner가 방을 해체했다. 재연결/재시도하지 않는다.
        // resume 없이 새 방에 다시 들어가야 첫 입장자가 host로 파일 기준 재시드한다.
        this.resetRequested = true
        this.setStatus('disconnected')
        this.emitReset()
        return
      }
      if (code === 1008) {
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

  /** 전용 타입(99/100/101) 처리부. own·transport 공통. */
  private handleOwnMessage(type: number, d: decoding.Decoder): void {
    if (type === 100) {
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

  private scheduleReconnect(): void {
    // A1′: transport 모드에서 provider가 disconnect()하지 않은 재연결은 허용한다.
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
    // Q1: 방 해체 통지를 받았으면 resume 경로를 쓰지 않는다(오염 doc 복원 방지).
    if (this.resetRequested) {
      this.resetRequested = false
      this.emitReset()
      return
    }
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

  /** Q2: 서버에 방 재설정을 요청한다 (WS type 101). 권한은 서버가 conn 기준으로 판단. */
  requestReset(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const e = encoding.createEncoder()
    encoding.writeVarUint(e, MSG_RESET_ROOM)
    this.send(encoding.toUint8Array(e))
  }

  /** Q1: 서버가 방을 해체했을 때 1회 호출. 이 세션은 더 이상 쓰지 않는다. */
  onReset(listener: () => void): () => void {
    this.resetListeners.add(listener)
    return () => {
      this.resetListeners.delete(listener)
    }
  }

  private emitReset(): void {
    const listeners = [...this.resetListeners]
    this.resetListeners.clear()
    for (const l of listeners) {
      try {
        l()
      } catch {
        // 무시
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
    // 전체 setLocalState는 lib의 PRESENCE_FIELD를 지우므로 field 병합으로 갱신한다.
    const prevApp = ((this.awareness.getLocalState() ?? {}).app ?? {}) as Record<string, unknown>
    this.awareness.setLocalStateField('app', {
      ...prevApp,
      id: this.userId,
      name: user.name,
      color: user.color,
    })
    this.user = user
  }

  /**
   * app 필드를 현재 값으로 다시 게시한다 (field 단위).
   * lib이 presence를 빌려 쓰다가 dispose하는 경로에서 app가 사라지는 것을 복구용으로 방어한다.
   * 확인 결과 borrowAwareness.dispose는 `{ ...current }` 스프레드라 app를 지우지 않지만,
   *  안전망으로 남긴다 (E20).
   */
  republishApp(): void {
    const st = (this.awareness.getLocalState() ?? {}) as Record<string, unknown>
    const app = (st.app ?? {}) as Record<string, unknown>
    if (Object.keys(app).length > 0) {
      // H3: 비교는 name/color/mode/slide/where 필드 단위로.
      // mode가 바뀌었는데 스킵하면 상대 화면에 '편집 중'이 계속 남는다.
      const fields: (keyof YCollabAppState)[] = ['name', 'color', 'mode', 'slide', 'where']
      const same = fields.every((k) => app[k as string] === this.lastApp[k as string])
      if (same) return
    }
    // G4: app가 통째로 사라졌으면 신원뿐 아니라 마지막 위치(slide/where)도 되살린다.
    const restored = {
      id: this.userId,
      name: this.user.name,
      color: this.user.color,
      mode: (app.mode as YCollabMode | undefined) ?? this.ownMode,
      ...(this.lastWhere ? { where: this.lastWhere } : {}),
      ...(this.lastSlide != null ? { slide: this.lastSlide } : {}),
      ...app,
    } as YCollabAppState
    this.lastApp = restored as unknown as Record<string, unknown>
    this.awareness.setLocalStateField('app', restored)
  }

  /** view/edit 전환. app.mode 갱신이 서버 owner 재선출을 유발한다. */
  setMode(mode: YCollabMode): void {
    const prev = (this.awareness.getLocalState() ?? {}) as Record<string, unknown>
    const prevApp = (prev.app ?? {}) as Record<string, unknown>
    this.lastApp = { ...prevApp, id: this.userId, mode }
    this.awareness.setLocalStateField('app', this.lastApp)
    this.ownMode = mode
  }

  /**
 * 위치 게시 1회 업데이트 (H1).
 * slide와 where를 따로 두면 awareness update가 2번 나가서 상대 화면에
 * "slide=3, where=슬라이드 1" 같은 중간 상태가 잠깐 보인다. 항상 한 번에 낸다.
 * 300ms debounce는 호출부에서 걸고, 값이 그대로면 아무것도 보내지 않는다.
 */
  setLocation(loc: { slide?: number | null; where?: string | null }): void {
    const slide =
      typeof loc.slide === 'number' && Number.isFinite(loc.slide) ? Math.max(1, Math.floor(loc.slide)) : null
    const where = typeof loc.where === 'string' ? loc.where.trim() : ''
    if (slide != null && this.lastSlide === slide && (!where || this.lastWhere === where)) return
    if (slide == null && !where) return
    const prevApp = (((this.awareness.getLocalState() ?? {}) as Record<string, unknown>).app ??
      {}) as Record<string, unknown>
    const next: Record<string, unknown> = { ...prevApp, id: this.userId }
    if (slide != null) next.slide = slide
    else delete next.slide
    if (where) next.where = where
    else delete next.where
    this.lastSlide = slide
    this.lastWhere = where || null
    this.lastApp = next
    this.awareness.setLocalStateField('app', next)
  }

  /** 위치 문자열만 (Sheet1!B3, 3쪽 등). */
  setWhere(where: string): void {
    this.setLocation({ where })
  }

  /** 슬라이드만 (PPT). where는 호출부가 함께 준다. */
  setSlide(n: number): void {
    this.setLocation({ slide: n })
  }

  /**
   * A1′: lib의 transportProvider({ transport })에 넘길 바이트 파이프.
   *
   * 계약(provider.d.ts:24-30):
   * - connect(handlers)로 채널이 열렸음을 알린다(소켓 open 시 open()).
   * - 받은 바이트는 **전용 타입(99/100/101)을 뺀 나머지**를 그대로 handlers.message에 넘긴다.
   *   (0=sync, 1=awareness, 3=queryAwareness — relay 와이어와 동일)
   * - send는 provider→서버 방향. open 전에는 조용히 버린다(다음 open에 재동기화된다).
   * - disconnect()는 재연결을 모두 멈춘다.
   */
  asTransport(): {
    connect: (handlers: TransportHandlers) => void
    send: (data: Uint8Array) => void
    disconnect: () => void
  } {
    return {
      connect: (handlers) => {
        this.transportHandlers = handlers
        // 소켓이 이미 열려 있으면 즉시 알린다 (connect 지연 호출 대응).
        // transportOpenNotified로 중복 open()을 막는다 — provider는 open마다 재동기화한다.
        if (this.ws && this.ws.readyState === WebSocket.OPEN && !this.transportOpenNotified) {
          this.transportOpenNotified = true
          handlers.open()
        }
      },
      send: (data) => {
        if (!this.transportHandlers) return
        this.send(data)
      },
      disconnect: () => {
        this.transportHandlers = null
        this.transportOpenNotified = false
        this.disconnectRequested = true
        try {
          this.ws?.close()
        } catch {
          // 무시
        }
        this.ws = null
      },
    }
  }

  /** P2: provider의 synced 이벤트를 이 세션 상태에 양방향으로 미러한다. */
  mirrorSynced(synced: boolean): void {
    if (this.synced === synced) return
    this.synced = synced
    if (synced) {
      this.retry = 0
      this.setStatus('connected')
    }
    this.emit()
  }

  /** P2: provider의 status 이벤트를 이 세션 상태에 미러한다. */
  mirrorStatus(status: YCollabStatus): void {
    if (this.status === status) return
    this.setStatus(status)
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
      this.doc.off('update', this.onDocActivity)
    } catch {
      // 무시
    }
    try {
      this.awareness.off('update', this.onAwarenessUpdate)
    } catch {
      // 무시
    }
    // A1′: transport 핸들러를 먼저 떼고 소켓을 닫는다 (provider가 close를 보고하고 멈춘다).
    this.transportHandlers = null
    this.transportOpenNotified = false
    try {
      this.ws?.close()
    } catch {
      // 무시
    }
    this.ws = null
    this.metaListeners.clear()
    this.activityListeners.clear()
    this.lastEditAt.clear()
    if (this.mode === 'own') {
      // own은 우리가 소유하므로 끝까지 정리한다.
      try {
        this.doc.destroy()
      } catch {
        // 무시
      }
    } else {
      // A1′ transport: doc/awareness는 lib session 소유다. 파괴하지 않고
      // 우리가 붙인 리스너만 뗀다(위에서 off 완료).
      try {
        this.awareness.off('update', this.onAwarenessUpdate)
      } catch {
        // 무시
      }
    }
    this.listeners.clear()
  }
}

/** Q1: 서버 room 해체 통지 코드. */
export const ROOM_RESET_CLOSE_CODE = 4001
/** Q2: reset 요청 WS 메시지 타입. */
export const MSG_RESET_ROOM = 101

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
