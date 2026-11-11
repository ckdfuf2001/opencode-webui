import { createHash, randomUUID } from 'node:crypto'
import { promises as fs, watch as fsWatch, type FSWatcher } from 'node:fs'
import path from 'node:path'
import * as Y from 'yjs'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { resolveWorkspaceFile, workspaceRootAbs } from './files'
import { readLibPresence } from '@opencode-webui/shared/lib/collab-presence'
import { writeFileContent } from './file-operations'
import { logger } from '../utils/logger'
import JSZip from 'jszip'
import {
  assembleDocxEmbed,
  assemblePptxEmbed,
  assembleXlsxEmbed,
  attachKindOf,
  listEmbedParts,
  normalizeEmbedPart,
  readEmbedPart,
  replaceEmbedPart,
  type ZipLike,
} from './office-embed'

const zipLoadJSZip = (b: Uint8Array): Promise<ZipLike> => JSZip.loadAsync(b) as unknown as Promise<ZipLike>

/**
 * 공동편집 room 레지스트리 (Phase 0 + v0.12.50).
 *
 * 원칙:
 * - 파일(디스크)이 원본, room(Y.Doc)은 열린 동안만 존재하는 휘발성 상태.
 *   Yjs를 서버에 영구 저장하지 않는다. 마지막 사람이 나가면 폐기(0명 30초 TTL).
 * - roomId = 'f_' + sha256(정규화 절대경로)[:40]. mtime을 넣으면 안 된다
 *   (저장할 때마다 room이 갈라진다).
 * - room마다 epoch(UUID). 서버 재시작 등으로 room이 새로 만들어지면 epoch가
 *   바뀌고, 이전 epoch의 resume은 거부된다.
 * - 첫 세션 요청자가 host, 첫 WS 접속 conn이 owner. 저장은 owner만.
 * - role은 클라이언트 권고일 뿐이다. 저장은 서버가 owner 집합으로 강제한다.
 * - 충돌 판정은 서버의 lastHash 기준이다. 클라이언트 baseHash는 진단용.
 * - seed 전(아무 update도 받지 않은 doc)의 저장은 거부한다.
 *
 * 알려진 한계: 백엔드 재시작 직전 5초 안에 owner가 저장했다면, guest의
 * knownHash가 오래돼서 resume이 409로 거부될 수 있다. 이 경우에도 사본
 * 다운로드로 안전하게 빠지므로 허용한다.
 */

export interface CollabSocket {
  send(data: Uint8Array): void
}

interface ConnInfo {
  joinedAt: number
  clientIds: Set<number>
  /** 마지막 수신 시각 (D: half-open 감지용). */
  lastMsgAt: number
}

/** 무수신 conn 정리 임계값 (D). 테스트는 sweepDeadConns를 직접 호출한다. */
export const DEAD_CONN_MS = 120_000

/** B3: 시딩 윈도우. 방 생성 후 이 시간 안의 원격 업데이트는 시딩으로 보고 dirty를 세지 않는다. */
export const DOC_DIRTY_GRACE_MS = 10_000

/**
 * C4: 시트 위 개체(이미지·도형·차트·EMB) 1개의 서버 측 상태.
 * 키는 서버가 발급한다(`o1`, `o2`, …). image/chart는 lib에 안정 식별자가 없어
 * cNvPr id를 쓰지 않는다(저장할 때마다 다시 매겨진다 — 0절 실측).
 */
export interface RoomObjectEntry {
  key: string
  /** 0-based 시트 인덱스. */
  sheet: number
  /** 클라이언트 모델 kind + 설명 (예: `image`, `chart`, `unsupported:shape`, `unsupported:object`). */
  kind: string
  /** 마지막으로 알려진 anchor (서버는 파싱하지 않고 그대로 들고 있는다). */
  anchor: unknown
  deleted: boolean
  /** 마지막 변경이 반영된 방 개체 버전. */
  version: number
  lock: { clientId: number; lockId: string; expiresAt: number } | null
}

/** C4: 방 단위 개체 표. 방 객체에 들고 있어 reset/dispose 때 함께 사라진다. */
export interface RoomObjects {
  byKey: Map<string, RoomObjectEntry>
  /** 파일 해시 → 시트별 살아 있는 키 순서 (`{ [sheet: string]: string[] }`). */
  orderByHash: Map<string, Record<string, string[]>>
  /** 개체 변경 카운터. move/delete 성공 때마다 +1, baseVersion 판정 기준. */
  version: number
  /** 키 발급 카운터. */
  seq: number
}

export function newRoomObjects(): RoomObjects {
  return { byKey: new Map(), orderByHash: new Map(), version: 0, seq: 0 }
}

/** C4: 개체 브로드캐스트 WS 메시지 타입 (99 keepalive·100 meta·101 reset 다음). */
export const MSG_ROOM_OBJECTS = 102

/** C4: 개체 락 임대 (ms). 만료는 다음 접근 때 정리한다. */
export const OBJECT_LOCK_TTL_MS = 10_000

export interface CollabRoom {
  id: string
  /** 정규화된 절대경로. */
  path: string
  /** room 세대. 서버 재시작 등으로 room이 다시 만들어지면 바뀐다. */
  epoch: string
  doc: Y.Doc
  awareness: awarenessProtocol.Awareness
  conns: Map<unknown, ConnInfo>
  /** 접속 순서 (owner 선출용). */
  order: unknown[]
  /** 현재 owner conn. */
  ownerConn: unknown | null
  /** owner conn이 기여한 awareness clientID 집합 (표시용). */
  ownerIds: Set<number>
  /** 한 번이라도 WS가 붙은 적 있는가 (고아 재활용 판단용). */
  everConnected: boolean
  /** 원격 update를 한 번이라도 받은 doc인가 (seed 여부). */
  seeded: boolean
  /** conns가 0이 된 시각 (TTL용, null이면 비어 있지 않음). */
  emptySince: number | null
  watcher: FSWatcher | null
  watchTimer: ReturnType<typeof setTimeout> | null
  /** 마지막으로 우리가 저장한(또는 room 생성 시 읽은) 해시. */
  lastHash: string
  /**
   * M10/D37: 자기 저장을 해시로 식별하기 위한 대기 해시 목록.
   * applySave 는 rename **전에** 새 해시를 여기에 넣고, rename 이 끝나면 lastHash 를
   * 갱신하면서 여기서 제거한다. watcher 가 이 목록에 있는 해시를 보면 자기 저장으로 보고 무시한다.
   * (시간 창 방식은 금지 — 파일 내용으로만 판단한다.)
   */
  pendingHashes: string[]
  /**
   * X1b: 이 방이 **직접 저장한** 해시 목록(최근 N개).
   * XLSX 저장 판정용이다: 디스크 해시가 이 목록에 있으면 "이 방의 참가자가 먼저 저장한 것"으로
   * 보고 클라이언트에 다시 직렬화·재시도를 지시한다. 목록에 없으면 외부 변경(AI 편집·보기 모드
   * 코멘트)이다 → 덮어쓰지 않고 배너·다운로드로 알린다.
   */
  recentSaveHashes: string[]
  /**
   * X1b: 방의 문서 종류. XLSX 는 앱(YCollabSession)이 아니라 lib(ooxml-ui xlsx)가 방을 소유한다.
   * lib 클라이언트는 type 100 room meta 를 모른다 ⇒ xlsx 방은 meta 방송을 하지 않는다
   * (외부 변경은 저장 시 409 로 판정한다).
   */
  kind: RoomKind
  externalChanged: boolean
  /** 4-0 가드용: 마지막으로 계측한 디스크 이미지 수 (undefined=미계측). */
  lastImageCounts: { media: number; refs: number } | null | undefined
  /** 저장 중에는 watcher가 무시한다. */
  saving: boolean
  /** AI 편집이 409로 막힌 마지막 시각 (V7 칩용). */
  aiBlockedAt: number | null
  /** C4: 시트 개체(이미지·도형·차트·EMB) 표. 방과 함께 생기고 방과 함께 사라진다. */
  objects: RoomObjects
  /**
   * C6c: 하위문서(part) 방. 같은 부모 파일 안의 임베딩 파트를 별도 Y.Doc으로 공유한다.
   * - path는 부모 절대경로(watcher는 부모 디렉터리를 본다).
   * - lastHash/seed/저장 기준은 파트 바이트 해시(부모 파일 해시가 아니다).
   */
  part?: { parentAbs: string; part: string }
  /**
   * U-parent: 진행 중인 부모 flush 요청 (있으면 1개 — 동시 PUT은 공유한다).
   * resolve는 서버가 직접 들고 있고, 104 수신·타임아웃·방 해체 때 1회만 호출한다.
   */
  pendingFlush: {
    promise: Promise<FlushResult>
    resolve: (r: FlushResult) => void
    timer: ReturnType<typeof setTimeout>
    /** flush를 요청한 conn (104는 이 conn의 응답만 받는다). */
    conn: unknown
    /** B1: 요청과 응답을 짝짓는 id. 104의 id가 다르면 무시한다. */
    requestId: string
    /** P0-1: flush 요청 시각. 이후에 끝난 저장은 ack 없어도 flush를 끝낼 수 있다. */
    requestedAt: number
  } | null
  /**
   * U-parent: 편집 conn이 떨어진 마지막 시각 (clean close 1000/1001이면 0으로 지운다).
   * conns가 비어 있을 때만 본다.
   */
  lastEditorDropAt: number
  /**
   * B3: 마지막 applySave 이후 Y 업데이트가 있었는가 (미저장 가능성).
   * 방 생성 직후 10초(시딩 윈도우)의 업데이트는 세지 않는다.
   */
  docDirty: boolean
  /** 방 생성 시각 (B3 시딩 윈도우 기준). */
  createdAt: number
  /** B3: 마지막 원격 Y 업데이트 시각 (flush 신선도 판정용). */
  lastRemoteUpdateAt: number
  /** B3: 마지막 applySave 성공 시각 (flush 신선도 판정용). */
  lastSaveAt: number
  /**
   * C6c-1: 미뤄진 부모 리셋. 파트 저장 때 부모에 열린 편집자가 있고 부모가
   * 입력 중이면 방을 닫지 않고 이 표시만 남긴다 (조용한 구간·첨부 종료·마지막
   * 퇴장 중 하나가 오면 리셋한다). 부모 화면에는 "첨부 변경 미반영" 배너로 보인다.
   * C6c-d-1: 미뤄진 동안의 부모 저장은 adopt 전 해시를 받아주고, 디스크의
   * adopt 파트를 들어온 부모 zip에 다시 끼워 쓴다 (옛 파트 덮개·409 방지).
   */
  pendingPartReset: {
    at: number
    /** 미룸 시작 직전 부모 해시 (타이핑 중이던 클라이언트의 base). */
    adoptBase: string | null
    /** 미뤄진 동안 부모 저장에 허용하는 base 집합 (adoptBase + 병합 저장 해시). 1회성 소비. */
    bases: string[]
    /** adopt된 파트 정규 경로 (디스크에서 읽어 들어온 부모 zip에 다시 끼운다). */
    parts: string[]
    /** 연속 입력 상한 (이 시각이 지나면 입력 중이어도 리셋한다). 타이머만, 폴링 없음. */
    deadlineAt: number
  } | null
  /** C6c-1: 미뤄진 리셋의 조용한 구간 타이머 (한 번에 하나, 재시작 가능). */
  partResetTimer: ReturnType<typeof setTimeout> | null
  /**
   * C7: 백그라운드 삽입 기록. POST /embed(신규 첨부)는 방을 리셋하지 않고
   * 이 목록에만 남긴 뒤 106으로 알린다. 이후 부모 저장은 목록의 파트를
   * 들어온 바이트에 다시 끼워 쓴다 (옛 모델 덮개 방지). 방 해체와 함께 사라진다.
   */
  knownEmbeds: KnownEmbed[]
  /**
   * C7b: 삽입 이후 저장한 clientId 집합 (1회 무료 패스 소비 기록).
   * 새 삽입마다 비운다. 같은 옛 base라도 아직 저장 안 한 clientId는 1회 받아준다.
   */
  embedPassUsed: Set<number>
}

/** C7: 백그라운드 삽입 1건 (106 페이로드와 동일). */
export interface KnownEmbed {
  /** 정규 파트 경로 (예: ppt/embeddings/a.docx). */
  norm: string
  /** 실제 기록된 파일명 (중복 시 -2 규칙 적용済). */
  name: string
  kind: 'pptx' | 'xlsx' | 'docx'
  /** 삽입 위치 (클릭 지점 또는 화면 정가운데 기본값). */
  pos: {
    slide?: number
    x?: number
    y?: number
    sheet?: number
    col?: number
    row?: number
    block?: number
    /** C7: docx 문단 텍스트 앞부분 (클라이언트 칩 위치 찾기용 힌트). */
    text?: string
  }
  /** 삽입 직전 방 해시 (stale base 1회성 허용용, 소비 후 null). */
  preHash: string | null
  /** C7b: 앵커 해시 (위치 저장용 — 재조립 시 동일 문단을 찾는다). */
  anchorHash?: string | null
}

export interface CollabParticipant {
  id: string
  name: string
  color: string
  mode: 'view' | 'edit'
slide?: number
  /** 공통 위치 표기(app.where): "슬라이드 3" / "Sheet1!B3" / "3쪽". */
  where?: string
  /** 서버 owner 집합에 awareness clientId가 들어있는가. */
  owner: boolean
  /** X2a: 브라우저별 사용자 id(lib presence 에 실린 경우). 탐색기 중복 제거 키. */
  userId?: string
}

export const rooms = new Map<string, CollabRoom>()

/** X1b: 파일 종류별로 방의 동작이 다르다(pptx = 앱 프로토콜, xlsx/docx = lib 프로토콜). */
export type RoomKind = 'pptx' | 'xlsx' | 'docx' | 'other'
export function roomKindFor(absPath: string): RoomKind {
  if (/\.xlsx$/i.test(absPath)) return 'xlsx'
  if (/\.pptx$/i.test(absPath)) return 'pptx'
  if (/\.docx$/i.test(absPath)) return 'docx'
  return 'other'
}
/** lib이 동기화를 소유하는 방(xlsx/docx). 앱 Y.Doc 방(pptx)과 규칙이 다르다. */
export function isLibRoomKind(kind: RoomKind | string | undefined): boolean {
  return kind === 'xlsx' || kind === 'docx'
}
/** path(abs 정규화) -> roomId. 같은 파일을 두 room이 열지 않게 한다. */
const pathIndex = new Map<string, string>()
/** C6c: part 방의 pathIndex 키 (부모 방과 충돌하지 않게 분리). */
export function pathKeyForPart(parentAbs: string, part: string): string {
  return `${normalizeAbs(parentAbs)}\n${normalizeEmbedPart(part)}`
}
/**
 * M10/D37: 방 생성 중복 방지(경합).
 *
 * 같은 파일에 대한 세션 POST 가 동시에 오면 방이 둘 만들어졌다. rooms 맵에는 나중 것이
 * 남고 앞의 방은 고아가 되는데, **고아 방의 watcher 도 살아 있다.** 그 watcher 는
 * 자기 방의 lastHash(오래된 해시)와 디스크를 비교하므로, 다른 방이 방금 쓴 파일을
 * "외부 변경"으로 오인한다 → externalChanged → 클라이언트 재접속 시도 → 409 →
 * owner 상실 → 편집이 디스크에 반영되지 않음(V1).
 *
 * 그래서 방 생성은 path 단위로 직렬화한다. 두 번째 호출은 생성을 기다렸다가
 * 이미 만들어진 방에 참가(guest)한다.
 */
const creatingRooms = new Map<string, Promise<CollabRoom>>()

export const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,128}$/
export const MAX_SAVE_BYTES = 50 * 1024 * 1024
/** 0명 room 유지 시간. 짧은 재연결 동안 room을 살린다. */
let roomTtlMs = 30_000
export function setRoomTtlMs(ms: number): void {
  roomTtlMs = ms
}

/**
 * C6c-1: 부모가 "조용하다"는 기준 (ms). 파트 저장 때 부모에 열린 편집자가 있고
 * 마지막 Y 업데이트가 이 시간 안에 있으면 리셋을 미룬다 (타이핑 중 화면 리셋 방지).
 * 미뤄진 리셋은 타이머(폴링 아님)로 조용한 구간에 수행한다.
 */
let parentQuietMs = 5000
export function setParentQuietMs(ms: number): void {
  parentQuietMs = ms
}

/**
 * C6c-d-3: 미뤄진 리셋의 연속 입력 상한 (ms). 조용한 구간 타이머가 입력마다
 * 다시 시작돼도, 첫 미룸부터 이 시간이 지나면 입력 중이어도 리셋한다.
 * 타이머만 쓰고 폴링은 하지 않는다.
 */
let parentResetMaxMs = 60_000
export function setParentResetMaxMs(ms: number): void {
  parentResetMaxMs = ms
}

/** 부모가 입력 중인가 (미저장 변경이 있거나 최근 Y 업데이트가 있음). */
function parentIsActive(room: CollabRoom): boolean {
  if (room.docDirty) return true
  return Date.now() - room.lastRemoteUpdateAt < parentQuietMs
}

/** C6c-1: 이 방(파트 방이면 부모 방)의 미뤄진 파트 변경 여부. */
export function hasDeferredPartChange(roomId: string): boolean {
  const r = rooms.get(roomId)
  if (!r) return false
  if (r.pendingPartReset) return true
  if (r.part) {
    const p = rooms.get(roomIdForAbs(r.part.parentAbs))
    return !!p?.pendingPartReset
  }
  return false
}

/**
 * C6c-f item 2: 미뤄진 부모 리셋을 수행한다 (조용한 구간·첨부 종료 시 호출).
 * 리셋 전에 flush(103→104, ≤8s)로 미저장을 디스크에 먼저 쓴다.
 * flush가 실패하면(타임아웃·무응답) 그래도 리셋은 진행하되, 클라이언트가
 * 사본 다운로드를 제안하도록 'embed_reset_unflushed' reason을 보낸다.
 */
export function doDeferredParentReset(parentId: string): void {
  const r = rooms.get(parentId)
  if (!r || !r.pendingPartReset) return
  r.pendingPartReset = null
  clearParentResetTimer(r)
  void flushThenResetParent(parentId)
}

/** 리셋 전 flush 후 4001 해체. 접속자가 없으면 flush를 건너뛴다 (받을 탭이 없다). */
async function flushThenResetParent(parentId: string): Promise<void> {
  let reason = 'embed_reset'
  const r = rooms.get(parentId)
  if (r && r.conns.size > 0 && (roomHasOpenEditor(parentId) || r.docDirty)) {
    try {
      const flush = await requestParentFlush(parentId)
      if (!flush.ok) reason = 'embed_reset_unflushed'
    } catch {
      reason = 'embed_reset_unflushed'
    }
  }
  resetRoomByServer(parentId, reason)
}

/**
 * C6c-d-1: 미뤄진 동안의 부모 저장에 adopt된 파트를 다시 끼운다.
 * 들어온 부모 바이트는 옛 파트를 들고 있으므로, 디스크(adopt 반영됨)에서
 * 각 파트의 현재 바이트를 읽어 교체한다. 파트가 디스크에 없으면 건너뛴다
 * (외부 삭제는 위 disk 대조에서 먼저 걸리므로 여기 올 수 없다).
 */
async function reembedAdoptedParts(room: CollabRoom, incoming: Uint8Array): Promise<Uint8Array> {
  const defer = room.pendingPartReset
  if (!defer || defer.parts.length === 0) return incoming
  let diskBytes: Uint8Array
  try {
    diskBytes = new Uint8Array(await fs.readFile(room.path))
  } catch {
    return incoming
  }
  let out = incoming
  for (const norm of defer.parts) {
    try {
      const cur = await readEmbedPart(zipLoadJSZip, diskBytes, norm)
      out = await replaceEmbedPart(zipLoadJSZip, out, norm, cur.bytes)
    } catch (e) {
      logger.warn(`Collab room ${room.id}: deferred re-embed skipped for ${norm} (${e instanceof Error ? e.message : e})`)
    }
  }
  return out
}

/**
 * C6c-d-1: 파트 저장을 부모 zip에 반영하고 방 리셋을 결정한다.
 * - 부모에 열린 편집자가 있고 부모가 입력 중이면 리셋을 미룬다 (4001로
 *   타이핑을 끊지 않는다). 디스크·방 해시는 즉시 adopt한다.
 * - 한가하면(편집자 없음/조용함) 즉시 리셋한다 (기존 동작).
 * 미루면 adopt 전 해시와 adopt 파트 목록을 남긴다: 미뤄진 동안의 부모 저장은
 * 이 해시를 받아주고 디스크의 adopt 파트를 다시 끼워 쓴다 (C6c-d-1).
 * 반환값: 리셋을 미뤘는지.
 */
export function adoptParentPartAndMaybeReset(
  parentId: string,
  newHash: string,
  partNorm?: string,
): { deferred: boolean } {
  const proom = rooms.get(parentId)
  if (!proom) return { deferred: false }
  const prevHash = proom.lastHash
  proom.lastHash = newHash
  proom.externalChanged = false
  if (roomHasOpenEditor(parentId) && parentIsActive(proom)) {
    const now = Date.now()
    const norm = partNorm ? normalizeEmbedPart(partNorm) : null
    const prev = proom.pendingPartReset
    if (!prev) {
      proom.pendingPartReset = {
        at: now,
        adoptBase: prevHash,
        bases: prevHash ? [prevHash] : [],
        parts: norm ? [norm] : [],
        deadlineAt: now + parentResetMaxMs,
      }
    } else {
      // 추가 adopt: 파트 목록만 넓힌다. 기준 해시·상한은 첫 미룸 그대로
      // (타이핑 중인 클라이언트의 base는 첫 adopt 전 해시다).
      if (norm && !prev.parts.includes(norm)) prev.parts.push(norm)
    }
    armParentResetTimer(parentId)
    broadcastMeta(proom)
    // C6N: lib 방(xlsx/docx)은 type 100 meta를 모르므로 별도 타입(105)으로
    // 미뤄진 파트 변경을 알린다. transport가 받아 배너를 띄운다.
    if (isLibRoomKind(proom.kind)) broadcast(proom, encodePartPending(parentId))
    logger.warn(`Collab room ${parentId.slice(0, 8)}: parent reset deferred (editing in progress)`)
    return { deferred: true }
  }
  clearParentResetTimer(proom)
  proom.pendingPartReset = null
  resetRoomByServer(parentId)
  return { deferred: false }
}

/** 미뤄진 리셋 타이머를 걸거나 갱신한다 (한 번에 하나). */
function armParentResetTimer(parentId: string): void {
  const r = rooms.get(parentId)
  if (!r || !r.pendingPartReset) return
  clearParentResetTimer(r)
  // C6c-d-3: 조용한 구간과 상한 중 먼저 오는 쪽에 깨운다 (타이머만, 폴링 없음).
  const delay = Math.max(250, Math.min(parentQuietMs, r.pendingPartReset.deadlineAt - Date.now()))
  r.partResetTimer = setTimeout(() => {
    r.partResetTimer = null
    const cur = rooms.get(parentId)
    if (!cur || !cur.pendingPartReset) return
    // 아직 입력 중이면 조용한 구간까지 미룬다 (타이머 체인, 폴링 아님).
    // 단, 상한이 지났으면 입력 중이어도 리셋한다 (C6c-d-3).
    if (parentIsActive(cur) && Date.now() < cur.pendingPartReset.deadlineAt) {
      armParentResetTimer(parentId)
      return
    }
    doDeferredParentReset(parentId)
  }, delay)
}

function clearParentResetTimer(room: CollabRoom): void {
  if (room.partResetTimer) {
    clearTimeout(room.partResetTimer)
    room.partResetTimer = null
  }
}

let sweepTimer: ReturnType<typeof setInterval> | null = null
/** 0명 room TTL 만료분을 정리한다. 테스트에서 직접 호출 가능. */
export function sweepRooms(now: number = Date.now()): void {
  for (const room of [...rooms.values()]) {
    if (room.conns.size === 0 && room.emptySince !== null && now - room.emptySince >= roomTtlMs) {
      logger.info(`Collab room ${room.id} expired after ${roomTtlMs}ms empty`)
      disposeRoom(room)
    }
  }
}
/** D: 120초 무수신 conn은 half-open으로 보고 정리한다. */
export function sweepDeadConns(now: number = Date.now()): void {
  for (const room of [...rooms.values()]) {
    for (const [ws, info] of [...room.conns.entries()]) {
      if (now - info.lastMsgAt < DEAD_CONN_MS) continue
      logger.info(`Collab room ${room.id}: dropping silent conn`)
      try {
        ;(ws as unknown as { close?: (code?: number) => void }).close?.(1001)
      } catch {
        // 무시
      }
      removeConn(room.id, ws)
    }
  }
}
/** type 99 keepalive: 유휴 room도 lastRxAt가 갱신되게 한다. */
function sendKeepalive(room: CollabRoom): void {
  if (room.conns.size === 0) return
  const e = encoding.createEncoder()
  encoding.writeVarUint(e, 99)
  broadcast(room, encoding.toUint8Array(e))
}
function ensureSweeper(): void {
  if (sweepTimer) return
  sweepTimer = setInterval(() => {
    sweepRooms()
    sweepDeadConns()
    for (const room of rooms.values()) sendKeepalive(room)
    if (rooms.size === 0 && sweepTimer) {
      clearInterval(sweepTimer)
      sweepTimer = null
    }
  }, 10_000)
  const t = sweepTimer as unknown as { unref?: () => void }
  if (typeof t.unref === 'function') t.unref()
}

export function normalizeAbs(p: string): string {
  const fwd = path.resolve(p).replace(/\\/g, '/')
  return process.platform === 'win32' ? fwd.toLowerCase() : fwd
}

export function roomIdForAbs(absPath: string): string {
  const h = createHash('sha256').update(normalizeAbs(absPath), 'utf8').digest('hex')
  return `f_${h.slice(0, 40)}`
}

/**
 * C6c: 하위문서(part) 방 id. 부모 파일 방과 절대 겹치지 않게 도메인을 분리한다.
 * (`embed-part` 접두 + 부모 경로 + 정규화 파트 경로를 해시 — 파일 방과 충돌 불가.)
 */
export function roomIdForPart(parentAbs: string, part: string): string {
  const h = createHash('sha256')
    .update(`embed-part\n${normalizeAbs(parentAbs)}\n${normalizeEmbedPart(part)}`, 'utf8')
    .digest('hex')
  return `f_${h.slice(0, 40)}`
}

/** C6c: 파트 방의 문서 종류 (파트 파일명으로 판정 — 부모 확장자와 무관). */
export function roomKindForPart(part: string): RoomKind {
  const base = normalizeEmbedPart(part).split('/').pop() ?? ''
  if (/\.xlsx$/i.test(base)) return 'xlsx'
  if (/\.pptx$/i.test(base)) return 'pptx'
  if (/\.docx$/i.test(base)) return 'docx'
  return 'other'
}

/** C6c: 방의 디스크 기준 바이트를 읽는다 (파일 방=파일 전체, 파트 방=부모 안 파트). */
export async function roomDiskBytes(room: CollabRoom): Promise<Uint8Array> {
  if (!room.part) return new Uint8Array(await fs.readFile(room.path))
  return partBytesOf(room.part.parentAbs, room.part.part)
}

/** C6c: 부모 zip에서 임베딩 파트 바이트를 꺼낸다 (없으면 404 throw). */
export async function partBytesOf(parentAbs: string, part: string): Promise<Uint8Array> {
  const norm = normalizeEmbedPart(part)
  let host: Uint8Array
  try {
    host = new Uint8Array(await fs.readFile(parentAbs))
  } catch {
    throw { message: 'Host file not readable', statusCode: 404 }
  }
  let names: string[]
  try {
    const zip = await zipLoadJSZip(host)
    names = Object.keys(zip.files)
  } catch {
    throw { message: 'Host is not a valid Office file', statusCode: 400, code: 'bad_host' }
  }
  if (!names.includes(norm)) throw { message: 'No such embedded part', statusCode: 404, code: 'bad_part' }
  const { bytes } = await readEmbedPart(zipLoadJSZip, host, norm)
  return bytes
}

/** C6c: 방의 디스크 해시 (파일 방=파일 해시, 파트 방=파트 바이트 해시). */
export async function roomDiskHash(room: CollabRoom): Promise<string | null> {
  try {
    return hashBytes(await roomDiskBytes(room))
  } catch {
    return null
  }
}

export function isValidRoomId(id: string): boolean {
  return ROOM_ID_RE.test(id)
}

export async function hashFile(absPath: string): Promise<string> {
  const buf = await fs.readFile(absPath)
  return createHash('sha256').update(buf).digest('hex')
}

export function hashBytes(buf: Uint8Array): string {
  return createHash('sha256').update(buf).digest('hex')
}

function sendTo(room: CollabRoom, ws: unknown, data: Uint8Array): void {
  try {
    ;(ws as CollabSocket).send(data)
  } catch (error) {
    logger.warn(`Collab room ${room.id}: send failed, dropping conn`)
    dropConnFromRoom(room, ws)
  }
}

function broadcast(room: CollabRoom, data: Uint8Array): void {
  // C4: 폐기된 방 참조로는 보내지 않는다. dispose 후 남은 stale conns에
  // getRoomObjects error({"error":"No such room"})가 102로 감싸져 나가
  // 클라이언트 개체 표를 깨뜨리는 유령 프레임을 막는다.
  if (rooms.get(room.id) !== room) return
  for (const ws of [...room.conns.keys()]) sendTo(room, ws, data)
}

/** y-websocket message 0 + sync.update 래핑. */
function encodeSyncUpdate(update: Uint8Array): Uint8Array {
  const e = encoding.createEncoder()
  encoding.writeVarUint(e, 0)
  syncProtocol.writeUpdate(e, update)
  return encoding.toUint8Array(e)
}

function encodeAwareness(clients: number[], awareness: awarenessProtocol.Awareness): Uint8Array {
  const e = encoding.createEncoder()
  encoding.writeVarUint(e, 1)
  encoding.writeVarUint8Array(e, awarenessProtocol.encodeAwarenessUpdate(awareness, clients))
  return encoding.toUint8Array(e)
}

/** type 100 room meta (서버→클라이언트 전용, lib은 모름). */
export interface RoomMeta {
  ownerClientId: number | null
  lastHash: string
  epoch: string
  externalChanged: boolean
  aiBlockedAt: number | null
  /** C6c-1: 파트 저장이 디스크에 반영됐지만 부모 방 리셋이 미뤄진 상태. */
  hasPendingPartChange?: boolean
}

function roomMeta(room: CollabRoom): RoomMeta {
  const owner = [...room.ownerIds][0] ?? null
  return {
    ownerClientId: owner,
    lastHash: room.lastHash,
    epoch: room.epoch,
    externalChanged: room.externalChanged,
    aiBlockedAt: room.aiBlockedAt,
    ...(room.pendingPartReset ? { hasPendingPartChange: true as const } : {}),
  }
}

function encodeMeta(room: CollabRoom): Uint8Array {
  const e = encoding.createEncoder()
  encoding.writeVarUint(e, 100)
  encoding.writeVarUint8Array(e, new TextEncoder().encode(JSON.stringify(roomMeta(room))))
  return encoding.toUint8Array(e)
}

function broadcastMeta(room: CollabRoom): void {
  if (room.conns.size === 0) return
  // X1b(P0-1(다)): XLSX/DOCX 방의 소켓은 lib(ooxml-ui) 클라이언트다.
  // 이 클라이언트는 type 100 room meta 를 모른다 ⇒ 보내지 않는다.
  // 외부 변경은 **저장 시 서버 판정(409 conflict_external)** 으로 알린다.
  if (isLibRoomKind(room.kind)) return
  broadcast(room, encodeMeta(room))
}

/** C6N: 미뤄진 파트 변경 알림 페이로드 (lib transport가 받아 배너를 띄운다). */
function encodePartPending(roomId: string): Uint8Array {
  const e = encoding.createEncoder()
  encoding.writeVarUint(e, MSG_PART_PENDING)
  encoding.writeVarUint8Array(e, new TextEncoder().encode(JSON.stringify({ roomId, hasPendingPartChange: true })))
  return encoding.toUint8Array(e)
}

/**
 * C7: 백그라운드 삽입 알림 (서버→방 전원). 리셋 없이 첨부 1건이 들어왔음을
 * 알린다. transport가 받아 오버레이에 칩을 얹고 baseHash를 newHash로 갱신한다
 * (다음 저장이 409 없이 나간다).
 */
export const MSG_PART_EMBEDDED = 106
export function encodePartEmbedded(
  roomId: string,
  rec: Pick<KnownEmbed, 'norm' | 'name' | 'kind' | 'pos'> & { newHash: string },
): Uint8Array {
  const e = encoding.createEncoder()
  encoding.writeVarUint(e, MSG_PART_EMBEDDED)
  encoding.writeVarUint8Array(
    e,
    new TextEncoder().encode(JSON.stringify({ roomId, part: rec.norm, name: rec.name, kind: rec.kind, pos: rec.pos, newHash: rec.newHash })),
  )
  return encoding.toUint8Array(e)
}

/**
 * C7: 백그라운드 삽입 등록 + 106 방송 (리셋 없음).
 * POST /embed(신규 첨부)가 디스크 쓰기·lastHash 갱신 뒤에 호출한다.
 */
export function registerEmbedInsert(parentId: string, rec: Omit<KnownEmbed, 'preHash'> & { preHash: string | null }): void {
  const proom = rooms.get(parentId)
  if (!proom || proom.part) return
  proom.knownEmbeds.push({ ...rec })
  if (proom.knownEmbeds.length > 32) {
    proom.knownEmbeds.splice(0, proom.knownEmbeds.length - 32)
    logger.warn(`Collab room ${parentId.slice(0, 8)}: knownEmbeds overflow, dropped oldest`)
  }
  // C7b: 새 삽입이면 모두에게 다시 1회 무료 패스를 준다.
  proom.embedPassUsed = new Set()
  broadcast(proom, encodePartEmbedded(parentId, { ...rec, newHash: proom.lastHash }))
}

/**
 * C7: 백그라운드 삽입 보존. 들어온 저장 바이트에 없는 known 파트를
 * 디스크 기준으로 같은 위치에 다시 조립한다 (옛 모델 덮개 방지).
 * 이미 있는 파트는 그대로 둔다 (교체는 pendingPartReset 경로가 담당).
 */
async function ensureKnownEmbeds(room: CollabRoom, incoming: Uint8Array): Promise<Uint8Array> {
  if (!room.knownEmbeds || room.knownEmbeds.length === 0) return incoming
  let diskBytes: Uint8Array
  try {
    diskBytes = new Uint8Array(await fs.readFile(room.path))
  } catch {
    return incoming
  }
  let out = incoming
  for (const ke of room.knownEmbeds) {
    try {
      const probe = await zipLoadJSZip(out)
      if (probe.files[ke.norm] && !probe.files[ke.norm]!.dir) continue
      const part = await readEmbedPart(zipLoadJSZip, diskBytes, ke.norm)
      if (ke.kind === 'pptx') {
        out = await assemblePptxEmbed(zipLoadJSZip, {
          hostBytes: out,
          attachBytes: part.bytes,
          attachName: ke.name,
          attachKind: attachKindOf(ke.name) ?? 'docx',
          slide: ke.pos.slide,
          xFrac: ke.pos.x,
          yFrac: ke.pos.y,
        })
      } else if (ke.kind === 'xlsx') {
        out = await assembleXlsxEmbed(zipLoadJSZip, {
          hostBytes: out,
          attachBytes: part.bytes,
          attachName: ke.name,
          attachKind: attachKindOf(ke.name) ?? 'docx',
          sheet: ke.pos.sheet,
          cellCol: ke.pos.col,
          cellRow: ke.pos.row,
        })
      } else {
        out = await assembleDocxEmbed(zipLoadJSZip, {
          hostBytes: out,
          attachBytes: part.bytes,
          attachName: ke.name,
          attachKind: attachKindOf(ke.name) ?? 'docx',
          block: ke.pos.block,
          blockText: ke.pos.text,
          anchorHash: ke.anchorHash ?? undefined,
        })
      }
    } catch (e) {
      logger.warn(`Collab room ${room.id.slice(0, 8)}: background re-embed skipped for ${ke.norm} (${e instanceof Error ? e.message : e})`)
    }
  }
  return out
}

/** conn의 모드. app.mode가 전부 view면 'view', 모르면 edit 취급(하위 호환). */
/**
 * X2a: 한 awareness 상태의 역할. PPT 는 app.mode, XLSX(lib)는 presence.role 로 알린다.
 * 둘 다 없으면 undefined(모름). 판정 자체는 호출자가 한다.
 */
function stateMode(st: unknown): 'view' | 'edit' | undefined {
  const app = (st as { app?: { mode?: unknown } } | undefined)?.app
  if (app && typeof app === 'object' && typeof app.mode === 'string') {
    return app.mode === 'view' ? 'view' : 'edit'
  }
  const lib = readLibPresence(st as Record<string, unknown> | undefined)
  if (lib) return lib.role === 'viewer' ? 'view' : 'edit'
  return undefined
}

export function connMode(room: CollabRoom, ws: unknown): 'view' | 'edit' {
  const info = room.conns.get(ws)
  if (!info || info.clientIds.size === 0) return 'edit'
  let sawKnown = false
  for (const cid of info.clientIds) {
    const m = stateMode(room.awareness.getStates().get(cid))
    if (m !== undefined) {
      sawKnown = true
      if (m !== 'view') return 'edit'
    }
  }
  return sawKnown ? 'view' : 'edit'
}

/** owner 재선출: edit 참가자 중 가장 먼저 들어온 conn. 없으면 owner 해제. */
function reevaluateOwner(room: CollabRoom): void {
  // C2-c: XLSX 방도 owner를 선출한다(자동 저장 1명 규칙). lib 클라이언트에는
  // type 100 meta를 보내지 않으므로(broadcastMeta가 xlsx를 건너뜀) 와이어는 안전하다.
  // 저장은 그대로 낙관적 잠금으로 판정한다(checkSave가 xlsx를 건너뜀).
  const current = room.ownerConn
  if (current !== null && current !== undefined && room.conns.has(current) && connMode(room, current) !== 'view') {
    // C: owner는 살아 있으나 ids가 비었다면(선출 시 awareness 미도착) 보수한다.
    // ids가 비면 클라이언트는 owner가 null인 것으로 본다 (owner null 고착).
    const info = room.conns.get(current)
    const next = new Set(info ? [...info.clientIds] : [])
    if (next.size !== room.ownerIds.size) {
      room.ownerIds = next
      broadcastMeta(room)
    }
    return
  }
  room.ownerConn = null
  room.ownerIds = new Set()
  for (const ws of room.order) {
    if (!room.conns.has(ws)) continue
    if (connMode(room, ws) === 'view') continue
    room.ownerConn = ws
    const info = room.conns.get(ws)
    room.ownerIds = new Set(info ? [...info.clientIds] : [])
    logger.info(`Collab room ${room.id}: owner elected`)
    break
  }
  // owner가 실제로 바뀌었을 때만 푸시한다 (view-only room 스팸 방지).
  if (room.ownerConn !== current) broadcastMeta(room)
  // M10/D37: owner 가 사라지는 경로는 conn close 와 TTL 뿐이어야 한다.
  // 살아 있는 edit conn 이 있는데 owner 가 없으면 예기치 않은 경로다 (V1 의 owner=null).
  if (!room.ownerConn && room.conns.size > 0) {
    const hasEditConn = [...room.conns.keys()].some((ws) => connMode(room, ws) !== 'view')
    if (hasEditConn) {
      logger.error(`Collab room ${room.id}: owner_cleared_unexpected (live edit conns=${room.conns.size})`)
    }
  }
}

/** AI 편집 409 시 기록 (V7 칩용). */
export function markAiBlocked(roomId: string): void {
  const room = rooms.get(roomId)
  if (!room) return
  room.aiBlockedAt = Date.now()
  broadcastMeta(room)
}

/**
 * C: owner가 필요한 상태인가. owner가 없거나 viewer이거나 ids가 비었는데
 * edit conn이 있으면 true (conn 추가·제거·awareness 변경 이벤트에서 바로 재선출).
 * 폴링 금지.
 */
function needsElection(room: CollabRoom): boolean {
  const oc = room.ownerConn
  if (oc === null || oc === undefined || !room.conns.has(oc)) return true
  try {
    if (connMode(room, oc) === 'view') return true
  } catch {
    return true
  }
  if (room.ownerIds.size === 0) return true
  return false
}

/**
 * C: 적어도 하나의 conn이 알려진(awareness 도착) 모드를 가졌는가.
 * addConn 직후에는 awareness가 아직 도착하지 않아 unknown이 edit으로 보인다 —
 * 이때 선출하면 view-only 방에 owner가 생긴다 (V5). awareness 도착 이벤트가
 * 오면 그때 선출하므로, addConn에서는 알려진 모드가 있을 때만 즉시 선출한다.
 */
function hasKnownMode(room: CollabRoom): boolean {
  try {
    const states = room.awareness.getStates() as Map<number, unknown>
    for (const info of room.conns.values()) {
      for (const cid of info.clientIds) {
        if (states.get(cid) !== undefined) return true
      }
    }
  } catch {
    /* 무시 */
  }
  return false
}

function createRoom(
  id: string,
  absPath: string,
  seedHash: string,
  part?: { parentAbs: string; part: string },
): CollabRoom {
  const doc = new Y.Doc()
  const awareness = new awarenessProtocol.Awareness(doc)
  awareness.setLocalState(null)
  const room: CollabRoom = {
    id,
    path: absPath,
    epoch: randomUUID(),
    doc,
    awareness,
    conns: new Map(),
    order: [],
    ownerConn: null,
    ownerIds: new Set(),
    everConnected: false,
    seeded: false,
    emptySince: Date.now(),
    watcher: null,
    watchTimer: null,
    lastHash: seedHash,
    pendingHashes: [],
    recentSaveHashes: [],
    kind: part ? roomKindForPart(part.part) : roomKindFor(absPath),
    externalChanged: false,
    lastImageCounts: undefined,
    saving: false,
    aiBlockedAt: null,
    objects: newRoomObjects(),
    pendingFlush: null,
    lastEditorDropAt: 0,
  docDirty: false,
  createdAt: Date.now(),
  lastRemoteUpdateAt: 0,
  lastSaveAt: 0,
  pendingPartReset: null,
  partResetTimer: null,
  knownEmbeds: [],
  embedPassUsed: new Set(),
}
  if (part) room.part = part
  awareness.on('update', (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    const info = room.conns.get(origin)
    if (info) {
      added.forEach((cid) => info.clientIds.add(cid))
      removed.forEach((cid) => info.clientIds.delete(cid))
    }
    if (origin !== null && origin !== undefined && origin === room.ownerConn) {
      added.forEach((cid) => room.ownerIds.add(cid))
      removed.forEach((cid) => room.ownerIds.delete(cid))
    }
    // owner가 비었거나 view-only가 되거나 ids가 비면 edit 참가자 중 첫 conn을 선출한다 (C).
    if (needsElection(room)) {
      reevaluateOwner(room)
    }
    // C4: awareness가 사라진 클라이언트의 개체 락은 즉시 푼다 (WS close 때도
    // dropConnFromRoom → removeAwarenessStates 를 거쳐 여기로 온다).
    if (removed.length > 0) releaseObjectLocks(room, removed)
    broadcast(room, encodeAwareness([...added, ...updated, ...removed], room.awareness))
  })
  doc.on('update', (update: Uint8Array, origin: unknown) => {
    // 서버는 직접 쓰지 않으므로 origin이 있는 update는 전부 원격 내용이다.
    if (origin !== null && origin !== undefined) {
      room.seeded = true
      // B3: 생성 직후 10초(시딩 윈도우) 이후의 원격 업데이트는 미저장으로 본다.
      // 시딩 자체(빈 방에 호스트가 올리는 초기 상태)는 dirty가 아니다.
      try {
        if (Date.now() - room.createdAt > DOC_DIRTY_GRACE_MS) room.docDirty = true
        room.lastRemoteUpdateAt = Date.now()
      } catch {
        /* 무시 */
      }
    }
    broadcast(room, encodeSyncUpdate(update))
  })
  rooms.set(id, room)
  // C6c: part 방은 부모 방과 pathIndex 키를 분리한다 (파일 조회가 part 방을 잡지 않게).
  pathIndex.set(room.part ? pathKeyForPart(room.part.parentAbs, room.part.part) : normalizeAbs(absPath), id)
  ensureSweeper()
  return room
}

/**
 * M10/D37: 자기 저장은 해시로 식별한다.
 *
 * 예외 판정: watcher 가 파일을 읽어 room.lastHash 와 비교 → 다르면 "외부 변경"으로 단정.
 * 문제: rename 직후 watcher 콜백이(lastHash 갱신 전) 실행되면 **우리가 방금 쓴 파일을
 * 외부 변경으로 오인**했다. 그 오인 → externalChanged → 배너 → 클라이언트 세션 재설정 →
 * owner 상실 → 편집이 디스크에 반영되지 않음(V1).
 *
 * 지금 판정:
 * 1) 이벤트 파일명이 대상 경로(temp 포함)와 다르면 무시. temp 파일은 무시한다.
 * 2) 짧게 디바운스한 뒤 **최종 경로에서만** 해시를 계산한다.
 * 3) 해시가 room.lastHash 또는 room.pendingHashes 에 있으면 자기 저장 → 무시.
 * 4) 읽기 실패/크기 0 이면 판정을 보류하고 재시도한다(잠깐의 쓰기 중간 상태 오인 방지).
 */
function startWatch(room: CollabRoom): void {
  if (room.watcher) return
  try {
    const dir = path.dirname(room.path)
    const base = path.basename(room.path)
    room.watcher = fsWatch(dir, (event, filename) => {
      const name = typeof filename === 'string' ? filename : filename?.toString() ?? ''
      // temp 파일(무시): writeFileContent 의 `${path}.tmp-${pid}-${ts}`.
      if (name.includes('.tmp-')) return
      if (name !== base) return
      if (room.watchTimer) clearTimeout(room.watchTimer)
      room.watchTimer = setTimeout(() => {
        room.watchTimer = null
        void (async () => {
          // 저장 중에 뜬 이벤트는 무시한다 (S6C).
          if (room.saving) return
          for (let attempt = 0; attempt < 3; attempt++) {
            let h: string | null = null
            try {
              const stat = await fs.stat(room.path)
              // 쓰기 중간(크기 0)이면 판정을 보류하고 재시도한다.
              // C6c: 파트 방은 부모 파일 해시가 아니라 파트 바이트 해시가 기준이다.
              if (stat.size > 0) h = await roomDiskHash(room)
            } catch {
              h = null
            }
            if (!h) {
              if (attempt < 2) {
                await new Promise((r) => setTimeout(r, 150))
                continue
              }
              // 계속 읽을 수 없다면 보류만 한다(외부 변경으로 단정하지 않는다).
              return
            }
            // 자기 저장: 마지막 해시 또는 저장 대기 중인 해시.
            if (h === room.lastHash || room.pendingHashes.includes(h)) return
            if (!room.externalChanged) {
              logger.warn(`Collab room ${room.id}: external change detected (not from owner save)`)
              room.externalChanged = true
              broadcastMeta(room)
            }
            return
          }
        })()
      }, 200)
    })
    room.watcher.on('error', () => {
      try { room.watcher?.close() } catch { /* 무시 */ }
      room.watcher = null
    })
  } catch (error) {
    logger.warn(`Collab room ${room.id}: watch failed:`, error)
  }
}

function stopWatch(room: CollabRoom): void {
  if (room.watchTimer) {
    clearTimeout(room.watchTimer)
    room.watchTimer = null
  }
  if (room.watcher) {
    try { room.watcher.close() } catch { /* 무시 */ }
    room.watcher = null
  }
}

function disposeRoom(room: CollabRoom): void {
  stopWatch(room)
  try {
    if (process.env.COLLAb_DEBUG_DISPOSE) console.log('[dispose-dbg]', room.id.slice(0, 8), new Error('trace').stack?.split('\n').slice(1, 7).join(' <- '))
  } catch {
    /* 무시 */
  }
  clearParentResetTimer(room)
  // U-parent: 대기 중인 flush는 방과 함께 끝난다 (PUT이 8초를 다 기다리지 않게).
  settlePendingFlush(room, { ok: false, reason: 'reset' })
  try { room.doc.destroy() } catch { /* 무시 */ }
  rooms.delete(room.id)
  // C6c: part 방은 분리된 pathIndex 키를 쓴다.
  const key = room.part ? pathKeyForPart(room.part.parentAbs, room.part.part) : normalizeAbs(room.path)
  if (pathIndex.get(key) === room.id) pathIndex.delete(key)
  logger.info(`Collab room ${room.id} disposed (last conn left)`)
}

export interface SessionResult {
  roomId: string
  role: 'host' | 'guest' | 'resume'
  epoch: string
  lastHash: string
  path: string
  /** C6c: 하위문서 방의 파트 경로 (파일 방이면 undefined). */
  part?: string
  /**
   * X1b(P0-2): 방이 낡았다는 서버 판정 결과(있으면 클라이언트는 방에 붙지 않는다).
   * `stale_room` = 디스크가 방의 마지막 저장과 다르다(외부 변경이 방 뒤에 있었음).
   * `stale_client` = 클라이언트가 가진 바이트의 해시가 디스크와 다르다.
   */
  stale?: boolean
  code?: 'stale_room' | 'stale_client'
  currentHash?: string | null
}

export interface ResumeOptions {
  resumeEpoch?: string
  knownHash?: string
  /** 재접속 클라이언트의 Y clientID (owner 복원 판단용). */
  clientId?: number
  /**
   * X1b(P0-2): 서버가 staleness 를 판정한다(XLSX 용).
   * 해시를 모르는 클라이언트는 fail-closed 로 붙지 않아야 하므로, 클라이언트 해시도 같이 준다.
   */
  strict?: boolean
}

/**
 * X1b(P0-2): 서버 측 stale 판정.
 * - 방이 있고 디스크 해시 != room.lastHash → 방이 낡았다(stale_room).
 * - knownHash(클라이언트가 가진 바이트 해시)가 디스크와 다르면 → stale_client.
 * 해시를 못 읽으면 판정 불가 → stale 아님(계속 진행한다).
 */
async function staleRoomCheck(
  abs: string,
  room: CollabRoom | undefined,
  knownHash?: string,
  part?: { parentAbs: string; part: string },
): Promise<{ stale: true; code: 'stale_room' | 'stale_client'; currentHash: string | null } | null> {
  let disk: string | null = null
  let failed = false
  try {
    // C6c: 파트 방은 부모 파일 해시가 아니라 파트 바이트 해시가 기준이다.
    disk = part ? hashBytes(await partBytesOf(part.parentAbs, part.part)) : await hashFile(abs)
  } catch {
    // X1c: strict 모드에서 판정 불가면 stale 로 처리한다(fail-closed).
    // XLSX 는 "방에 먼저 들어온 문서"가 방의 기준이라, 디스크와 어긋난 방에 붙으면
    // 낡은 내용이 디스크를 덮어쓴다.
    failed = true
  }
  if (failed) return { stale: true, code: 'stale_room', currentHash: null }
  if (knownHash && disk && knownHash !== disk) {
    return { stale: true, code: 'stale_client', currentHash: disk }
  }
  if (room && disk && room.lastHash && disk !== room.lastHash) {
    return { stale: true, code: 'stale_room', currentHash: disk }
  }
  return null
}

/**
 * 세션 생성/참가/재개.
 *
 * | 상황 | 처리 |
 * |---|---|---|
 * | room 없음, resume 없음 | 새 epoch 발급, role=host(seed) |
 * | room 없음, resume 있음, 디스크 == knownHash | epoch 유지하고 재생성, role=resume(seed 금지) |
 * | room 없음, resume 있음, 디스크 != knownHash | 409 external_change |
 * | room 있음, resume 없음 | join, role=guest. 단 conns==0이면 dispose 후 host로 재생성 |
 * | room 있음, epoch 일치 | join (이전 owner였으면 즉시 복원) |
 * | room 있음, epoch 불일치 | 409 epoch_mismatch |
 */
export async function createSession(
  userPath: string,
  opts?: ResumeOptions & { part?: string },
): Promise<SessionResult> {
  const abs = await resolveWorkspaceFile(String(userPath ?? ''))
  if (!abs) throw { message: 'File not found', statusCode: 404 }
  // C6c: part 지정이면 부모 파일 안 임베딩 방 (정규화 + 존재 확인 — 경로 조작 차단).
  let partInfo: { parentAbs: string; part: string } | undefined
  if (opts?.part !== undefined) {
    const norm = normalizeEmbedPart(String(opts.part))
    await partBytesOf(abs, norm) // 없으면 404 throw
    partInfo = { parentAbs: abs, part: norm }
  }
  const id = partInfo ? roomIdForPart(abs, partInfo.part) : roomIdForAbs(abs)
  const resumeEpoch = opts?.resumeEpoch
  let existing = rooms.get(id)
  // C6c: 디스크 기준 해시 (파일 방=파일 전체, 파트 방=파트 바이트).
  const diskOf = async (): Promise<string> => {
    if (!partInfo) return hashFile(abs)
    return hashBytes(await partBytesOf(abs, partInfo.part))
  }

  // X1b(P0-2): strict 세션은 **서버가** staleness 를 판정한다.
  // XLSX(lib 방)는 "방에 먼저 들어온 문서"가 방의 기준이라, 디스크와 어긋난 방에 붙으면
  // 낡은 내용이 디스크를 덮어쓴다.
  // C2-a: knownHash는 클라이언트가 준 서버 ETag다(subtle 계산 없음).
  // P0-4: knownHash는 GET /embed 응답의 파트 해시(ETag)를 그대로 쓴다.
  // subtle이 없는 http에서도 서버가 준 값이라 strict 검증이 된다.
  if (opts?.strict) {
    const stale = await staleRoomCheck(abs, existing, opts?.knownHash, partInfo)
    if (stale) {
      // C2-b: 빈 방의 stale_room은 서버가 디스크 기준으로 리셋한다.
      // conns==0 && everConnected(붙었다 나간 고아 방)만 해당한다.
      // 한 번도 붙지 않은 방은 host가 오는 중일 수 있어 건드리지 않는다.
      // stale 방을 버려도 안전한 이유: 방에 남은 사람이 없고, 방 내용은
      // 마지막 저장(디스크)과 어긋난 상태이므로 디스크가 최신이다.
      const orphan = existing
      const emptyStaleRoom =
        stale.code === 'stale_room' && !!orphan && orphan.conns.size === 0 && orphan.everConnected
      if (!emptyStaleRoom) {
        return { roomId: id, role: 'guest', epoch: existing?.epoch ?? '', lastHash: existing?.lastHash ?? '', path: abs, ...stale }
      }
      // 같은 id로 새 방이 생겼으면(경합) 건드리지 않는다.
      if (orphan && rooms.get(id) === orphan) disposeRoom(orphan)
      existing = undefined
    }
  }

  if (!existing) {
    // M10/D37: 동시 세션 POST 경합 — 이미 생성이 진행 중이면 기다렸다가 참가한다.
    const creating = creatingRooms.get(id)
    if (creating) {
      try {
        const room = await creating
        return { roomId: id, role: 'guest', epoch: room.epoch, lastHash: room.lastHash, path: abs, part: partInfo?.part }
      } catch {
        // 생성이 실패하면 아래 경로에서 다시 시도한다.
      }
    }
    const creatingPromise = (async (): Promise<CollabRoom> => {
      let fileHash: string
      try {
        fileHash = await diskOf()
      } catch {
        throw { message: 'File not readable', statusCode: 404 }
      }
      if (resumeEpoch) {
        // 이전 epoch 로 복귀: 디스크가 바뀌었으면 외부 변경으로 거부한다.
        if (fileHash !== opts?.knownHash) {
          throw { message: 'File changed while away (no auto-merge)', statusCode: 409, code: 'external_change', currentHash: fileHash }
        }
        const room = createRoom(id, abs, fileHash, partInfo)
        room.epoch = resumeEpoch
        startWatch(room)
        logger.info(`Collab room ${id} re-created on resume (epoch kept)`)
        return room
      }
      const room = createRoom(id, abs, fileHash, partInfo)
      startWatch(room)
      logger.info(`Collab room ${id} created for ${abs}${partInfo ? ` part ${partInfo.part}` : ''}`)
      return room
    })()
    creatingRooms.set(id, creatingPromise)
    try {
      const room = await creatingPromise
      const role = resumeEpoch ? 'resume' : 'host'
      return { roomId: id, role, epoch: room.epoch, lastHash: room.lastHash, path: abs, part: partInfo?.part }
    } finally {
      if (creatingRooms.get(id) === creatingPromise) creatingRooms.delete(id)
    }
  }

  if (!resumeEpoch) {
    if (existing.conns.size === 0 && existing.everConnected) {
      // 붙었다 나간 고아 room: 정리하고 host로 재생성한다.
      // (한 번도 붙지 않은 room은 host가 오는 중일 수 있어 guest로 참가한다.
      // 무조건 재생성하면 host 세션-POST와 guest WS-connect 사이 경합에서
      // host 방을 guest가 빼앗는 레이스가 생긴다.)
      disposeRoom(existing)
      let fileHash: string
      try {
        fileHash = await diskOf()
      } catch {
        throw { message: 'File not readable', statusCode: 404 }
      }
      const room = createRoom(id, abs, fileHash, partInfo)
      startWatch(room)
      logger.info(`Collab room ${id} re-created (orphan disposed, host)`)
      return { roomId: id, role: 'host', epoch: room.epoch, lastHash: fileHash, path: abs, part: partInfo?.part }
    }
    return { roomId: id, role: 'guest', epoch: existing.epoch, lastHash: existing.lastHash, path: abs, part: partInfo?.part }
  }

  if (resumeEpoch !== existing.epoch) {
    throw { message: 'Another session started this file', statusCode: 409, code: 'epoch_mismatch' }
  }
  // 같은 epoch 복귀: 판정은 서버 lastHash 기준이다 (클라이언트 knownHash 아님).
  // 디스크가 마지막 저장과 다르면 외부 변경으로 거부한다.
  {
    let disk: string | null = null
    try {
      disk = await diskOf()
    } catch {
      throw { message: 'File not readable', statusCode: 404 }
    }
    if (disk !== existing.lastHash) {
      throw { message: 'File changed while away (no auto-merge)', statusCode: 409, code: 'external_change', currentHash: disk }
    }
  }
  return { roomId: id, role: 'resume', epoch: existing.epoch, lastHash: existing.lastHash, path: abs, part: partInfo?.part }
}

/** WS 접속 등록. owner는 첫 awareness가 증명한 conn이 된다. syncStep1 + awareness 스냅샷을 보낸다. */
export function addConn(roomId: string, ws: unknown): CollabRoom | null {
  const room = rooms.get(roomId)
  if (!room) return null
  const sock = ws as CollabSocket
  if (!room.conns.has(ws)) {
    room.conns.set(ws, { joinedAt: Date.now(), clientIds: new Set(), lastMsgAt: Date.now() })
    room.order.push(ws)
    room.emptySince = null
    room.everConnected = true
    // C: 새로 붙은 conn이 있는데 owner가 없으면 바로 선출한다.
    // 단 awareness 도착 전(unknown)에는 선출하지 않는다 — view-only 방에
    // owner가 생긴다 (V5). awareness 도착 이벤트가 오면 그때 선출한다.
    if (needsElection(room) && hasKnownMode(room)) reevaluateOwner(room)
    broadcastMeta(room)
  }
  const e = encoding.createEncoder()
  encoding.writeVarUint(e, 0)
  syncProtocol.writeSyncStep1(e, room.doc)
  try {
    sock.send(encoding.toUint8Array(e))
  } catch {
    dropConnFromRoom(room, ws)
    return null
  }
  const states = [...room.awareness.getStates().keys()] as number[]
  if (states.length > 0) {
    try {
      sock.send(encodeAwareness(states, room.awareness))
    } catch { /* 무시 */ }
  }
  // C4: 새로 붙은 conn에 현재 개체 표를 직접 보낸다 (그 사이 브로드캐스트를
  // 놓친 탭도 (재)연결 즉시 따라잡는다 — Yjs sync-step1과 같은 역할).
  // lib은 모르는 타입(102)이라 무시하고, 탭이 가로채 적용한다.
  if (room.objects.byKey.size > 0) {
    try {
      sock.send(encodeObjects(room))
    } catch { /* 무시 */ }
  }
  // C6N: 미뤄진 파트 변경을 놓친 탭((재)연결·늦은 참가)도 즉시 따라잡는다.
  // lib은 모르는 타입(105)이라 무시하고, 탭이 가로채 배너를 띄운다.
  if (room.pendingPartReset) {
    try {
      sock.send(encodePartPending(roomId))
    } catch { /* 무시 */ }
  }
  // C7b: 백그라운드 삽입을 놓친 탭((재)연결·늦은 참가)도 즉시 따라잡는다.
  // lib은 모르는 타입(106)이라 무시하고, 탭이 가로채 칩을 얹는다.
  if (room.knownEmbeds.length > 0) {
    try {
      for (const ke of room.knownEmbeds) {
        sock.send(encodePartEmbedded(roomId, { ...ke, newHash: room.lastHash }))
      }
    } catch { /* 무시 */ }
  }
  return room
}

export function isOwner(room: CollabRoom, clientId: number): boolean {
  return room.ownerIds.has(clientId)
}

/**
 * P0-1: 부모 경로 단위 저장 직렬화 체인. 부모 방과 그 안의 모든 파트 방이
 * 같은 체인을 공유한다 — 같은 파일을 건드리는 저장이 엇갈려 덮어쓰지 않는다.
 * flush 응답 저장(pendingFlush 보유 방)은 체인을 타지 않는다: 체인을 잡은
 * 파트 저장이 그 응답을 기다리므로 같이 타면 교착한다. flush 응답 시점에
 * 체인 대기자는 곧 그 파트 저장 하나뿐이라 안전하다.
 */
const saveChains = new Map<string, Promise<void>>()

function parentChainKey(room: CollabRoom): string {
  return normalizeAbs(room.part ? room.part.parentAbs : room.path)
}

/**
 * P0-1: 부모 경로 단위 직렬화 실행기. PUT /save(applySave) 외에
 * POST /embed(삽입) · PUT /embed(파트 교체)도 같은 부모 체인을 탄다 —
 * 같은 파일을 건드리는 쓰기가 엇갈려 덮어쓰지 않는다.
 * (flush 응답 저장은 applySave에서만 우회한다; embed는 항상 체인을 탄다.)
 */
export async function runParentChained<T>(absPath: string, fn: () => Promise<T>): Promise<T> {
  const key = normalizeAbs(absPath)
  const prev = saveChains.get(key) ?? Promise.resolve()
  const run = prev.then(fn)
  saveChains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  )
  return run
}

/**
 * P0-3: 방 리셋 빈도 계측. 무접속 리셋은 dispose되지만 집계에서 제외한다
 * (수행돼서 기록되는 리셋은 전부 disruptive다).
 */
export interface RoomResetStats {
  total: number
  disruptive: number
  lastAt: number
}
const resetStatsMap = new Map<string, RoomResetStats>()

export function resetStats(roomId: string): RoomResetStats | null {
  return resetStatsMap.get(roomId) ?? null
}

function noteReset(roomId: string, conns: number): void {
  const st = resetStatsMap.get(roomId) ?? { total: 0, disruptive: 0, lastAt: 0 }
  st.total += 1
  if (conns > 0) st.disruptive += 1
  st.lastAt = Date.now()
  resetStatsMap.set(roomId, st)
}

/** y-websocket 메시지 처리 (0=sync, 1=awareness). */
export function wsMessage(roomId: string, ws: unknown, data: Uint8Array): void {
  const room = rooms.get(roomId)
  if (!room || !room.conns.has(ws)) return
  room.conns.get(ws)!.lastMsgAt = Date.now()
  let d: ReturnType<typeof decoding.createDecoder>
  try {
    d = decoding.createDecoder(data)
  } catch {
    return
  }
  const sock = ws as CollabSocket
  try {
    const messageType = decoding.readVarUint(d)
    if (messageType === 0) {
      const e = encoding.createEncoder()
      encoding.writeVarUint(e, 0)
      syncProtocol.readSyncMessage(d, e, room.doc, ws)
      if (encoding.length(e) > 1) sock.send(encoding.toUint8Array(e))
    } else if (messageType === 1) {
      awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(d), ws)
    } else if (messageType === MSG_RESET_ROOM) {
      // Q2: reset은 WS로만 받는다 — body clientId는 owner 사칭에 취약하다.
      // 이 conn이 ownerConn인지 서버가 직접 대조한다.
      const result = resetRoomFromDisk(roomId, ws)
      logger.info(`Collab room ${roomId}: reset request from conn → ${JSON.stringify(result)}`)
    } else if (messageType === MSG_FLUSHED) {
      // U-parent: 부모 flush 확인. 같은 conn + 같은 requestId의 응답만 받는다 (B1).
      // B2 clean-ack라도 방이 dirty면(다른 참가자의 미저장) 바로 끝내지 않고
      // 저장을 기다린다 — 유실 방지. 타임아웃이면 409.
      let ok = false
      let rid: string | undefined
      try {
        const raw = decoding.readVarUint8Array(d)
        const body = JSON.parse(new TextDecoder().decode(raw)) as { ok?: boolean; requestId?: unknown }
        ok = body.ok === true
        if (typeof body.requestId === 'string') rid = body.requestId
      } catch {
        ok = false
      }
      const p = room.pendingFlush
      if (ok && p && (rid === undefined || p.requestId === rid) && room.docDirty) {
        logger.warn(`Collab room ${roomId}: parent flush ack ok but room dirty — waiting for save`)
      } else {
        const settled = settlePendingFlush(room, ok ? { ok: true, reason: 'flushed' } : { ok: false, reason: 'client_fail' }, ws, rid)
        if (settled) logger.info(`Collab room ${roomId}: parent flush ack ok=${ok}`)
      }
    }
  } catch (error) {
    logger.warn(`Collab room ${roomId}: bad message ignored`)
  }
}

function dropConnFromRoom(room: CollabRoom, ws: unknown): void {
  const info = room.conns.get(ws)
  if (info) {
    try {
      awarenessProtocol.removeAwarenessStates(room.awareness, [...info.clientIds], null)
    } catch { /* 무시 */ }
    for (const cid of info.clientIds) room.ownerIds.delete(cid)
  }
  // U-parent: 편집 conn이 떨어졌다. clean close(1000)는 onClose에서 지운다.
  // (크래시·오프라인은 1006/무프레임이라 남는다 → PUT 409 근거.)
  try {
    if (connMode(room, ws) !== 'view') room.lastEditorDropAt = Date.now()
  } catch {
    /* 무시 */
  }
  room.conns.delete(ws)
  room.order = room.order.filter((w) => w !== ws)
  if (room.ownerConn === ws) {
    room.ownerConn = null
    room.ownerIds = new Set()
  }
  // C: owner가 빠졌거나 ids가 비었으면 남은 edit 참가자 중 첫 conn으로 바로 승계한다.
  if (needsElection(room)) {
    reevaluateOwner(room)
  }
  if (room.conns.size === 0) {
    room.emptySince = Date.now()
    ensureSweeper()
    // C6c-d-2: 미뤄진 변경이 있는 방은 마지막 퇴장 때 즉시 dispose한다.
    // TTL(30초)을 기다리면 그 안 재입장이 strict를 통과해 옛 Y 상태를 받고,
    // 자동저장이 디스크의 새 첨부를 덮는다 (C6c-b 1번 함정 재발).
    if (room.pendingPartReset) doDeferredParentReset(room.id)
  }
}

export function removeConn(roomId: string, ws: unknown): void {
  const room = rooms.get(roomId)
  if (!room) return
  dropConnFromRoom(room, ws)
  // C6c-1: 파트 방이 비면(첨부 편집자 Done/종료) 미뤄둔 부모 리셋을 지금 한다.
  if (room.part && room.conns.size === 0) {
    try {
      const parentId = roomIdForAbs(room.part.parentAbs)
      const proom = rooms.get(parentId)
      if (proom?.pendingPartReset) doDeferredParentReset(parentId)
    } catch {
      /* 무시 */
    }
  }
}

export interface SaveCheck {
  ok: boolean
  status?: number
  error?: string
  code?: string
}

/** clientId가 현재 ownerConn에 속하는지 검증한다 (S6B). */
function isCurrentOwner(room: CollabRoom, clientId: number): boolean {
  if (!Number.isInteger(clientId)) return false
  const oc = room.ownerConn
  if (oc === null || oc === undefined || !room.conns.has(oc)) return false
  const info = room.conns.get(oc)
  return !!info && info.clientIds.has(clientId)
}

export function checkSave(
  roomId: string,
  clientId: number,
  byteLength: number,
  opts?: { kind?: RoomKind },
): SaveCheck {
  const room = rooms.get(roomId)
  if (!room) return { ok: false, status: 404, error: 'No such room', code: 'no_room' }
  // X1b: XLSX 방은 lib(ooxml-ui)가 소유한다 → owner/seeded 개념이 없다.
  // 저장은 낙관적 잠금(base hash) 으로만 판정한다.
  if (!isLibRoomKind(opts?.kind)) {
    if (!room.seeded) {
      return { ok: false, status: 409, error: 'Room has no synced content yet', code: 'not_seeded' }
    }
    if (!isCurrentOwner(room, clientId)) {
      return { ok: false, status: 409, error: 'Only the current owner can save', code: 'not_owner' }
    }
  }
  if (byteLength > MAX_SAVE_BYTES) {
    return { ok: false, status: 413, error: 'File too large', code: 'too_large' }
  }
  return { ok: true }
}

export async function currentDiskHash(roomId: string): Promise<string | null> {
  const room = rooms.get(roomId)
  if (!room) return null
  // C6c: 파트 방은 부모 파일이 아니라 파트 바이트가 기준이다.
  return roomDiskHash(room)
}

/**
 * zip 바이트에서 이미지 파트 수와 slide rel의 image 관계 수를 센다.
 * 이미지 손실 가드(4-0)와 계측에 쓴다. 읽기 실패면 null(판정하지 않음).
 *
 * M9/6절 수정: media 계수를 "정규식 문자열 탐색" 에서 "ZIP 로컬 파일 헤더 파싱" 으로
 * 바꾼다. 예전 로직은 로컬 헤더와 중앙 디렉터리 양쪽에서 같은 이름을 두 번 세고,
 * 이름 길이 검사(`> 'ppt/media/'.length`)는 정규식이 NUL 직전까지 greedily 매칭해서
 * 'ppt/media/' 디렉터리 엔트리까지 media 로 세었다.
 *   실제 이미지 3장짜리 fixture → 예전 계수 8, 새 계수 3
 * 앱이 저장한 바이트(ZIP 디렉터리 엔트리 없음) → 예전 계수 6, 새 계수 3
 * → "8 -> 6" 이라는 손실로 오탐해 **이미지가 있는 덱은 저장이 아예 막혔다.**
 * (E2: live text reflection + disk 실패의 근본 원인. 데이터 손실은 없었고,
 *  가드가 막아서 디스크 파일은 그대로였다.)
 */
export function countPptxImages(
  bytes: Uint8Array,
): { media: number; refs: number } | null {
  try {
    const buf = Buffer.from(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    ) as Buffer
    const LOCAL_HEADER_SIG = Buffer.from([0x50, 0x4b, 0x03, 0x04])
    let media = 0
    let refs = 0
    // ZIP 로컬 파일 헤더(PK\x03\x04)를 훑어 파일 이름을 한 번씩만 센다.
    for (let p = 0; p + 30 <= buf.length; ) {
      if (buf.readUInt32LE(p) !== 0x04034b50) {
        p += 1
        continue
      }
      const nameLen = buf.readUInt16LE(p + 26)
      const extraLen = buf.readUInt16LE(p + 28)
      const compSize = buf.readUInt32LE(p + 18)
      const name = buf.subarray(p + 30, p + 30 + nameLen).toString('latin1')
      // 디렉터리 엔트리는 이름이 '/' 로 끝난다 → 이미지가 아니다.
      if (name.startsWith('ppt/media/') && !name.endsWith('/')) media += 1
      const headerEnd = p + 30 + nameLen + extraLen
      // 압축 크기를 알면 데이터까지 건너뛴다(데이터 안의 바이트열 오인 방지).
      // 데이터 디스크립터(flag bit 3)라 로컬 헤더의 크기가 0 이면
      // 다음 로컬 헤더 시그니처를 찾아서 간다.
      if (compSize > 0) {
        p = headerEnd + compSize
      } else {
        const next = buf.indexOf(LOCAL_HEADER_SIG, headerEnd)
        if (next < 0) break
        p = next
      }
    }
    // image 관계 수: TargetMode 없는 image 관계 Target 개수.
    // (rel 파일은 deflate 로 압축돼 있어 원문 바이트로는 보이지 않는다 → 대개 0)
    const text = buf.toString('latin1')
    const reRef = /relationships\/image"[^>]*Target="/g
    let m: RegExpExecArray | null
    while ((m = reRef.exec(text)) !== null) {
      refs += 1
      if (refs > 4000) break
    }
    return { media, refs }
  } catch {
    return null
  }
}

/** 직전 저장본(디스크)의 이미지 계측값. room에 캐시한다. */
async function diskImageCounts(room: CollabRoom): Promise<{ media: number; refs: number } | null> {
  if (room.lastImageCounts !== undefined) return room.lastImageCounts
  try {
    // C6c: 파트 방은 부모 파일이 아니라 파트 바이트가 기준이다.
    const buf = await roomDiskBytes(room)
    const counts = countPptxImages(new Uint8Array(buf))
    room.lastImageCounts = counts
    return counts
  } catch {
    return null
  }
}

/** Q1: reset 통지용 WS close 코드. 클라이언트는 이 코드로 '재입장'을 안다. */
export const CLOSE_ROOM_RESET = 4001
/** Q2: reset 요청 WS 메시지 타입 (클라이언트→서버). */
export const MSG_RESET_ROOM = 101
/**
 * U-parent: 부모 flush 요청 (서버→부모 방 owner) + 확인 (클라이언트→서버).
 * 103을 받은 탭은 officeSaveRequest로 즉시 저장하고, officeSaveDone를 보면 104 {ok}로 답한다.
 * 서버 PUT /embed는 104 ok(또는 clean ack)를 받아야 디스크를 교체한다. 최대 8초 대기.
 */
export const MSG_FLUSH_REQUEST = 103
export const MSG_FLUSHED = 104
/**
 * C6N: 미뤄진 파트 변경 알림 (서버→방 전원). lib 방(xlsx/docx)은 type 100
 * meta를 모르므로 별도 타입으로 보낸다. transport가 받아 배너를 띄운다
 * (pptx는 기존 meta 경로 그대로).
 */
export const MSG_PART_PENDING = 105
/** U-parent: flush 전체 예산 (owner 선출 대기 3초 포함). D64 "최대 8초 대기". */
export const FLUSH_WAIT_MS = 8000
/** U-parent: owner 선출 대기 상한 (재접속 레이스용, 전체 예산 안에 든다). */
const FLUSH_OWNER_WAIT_MS = 3000

/** U-parent: 부모 flush 요청 결과. */
export interface FlushResult {
  ok: boolean
  reason: string
}

/**
 * Q1: 오염된 room 복구.
 * doc을 제자리에서 비우지 않는다(그 순간 접속 중인 전원에게 빈 상태가 전파된다).
 * 대신 전원 conn을 room_reset 코드로 닫고 room을 완전히 해체한다.
 * 이후 각 클라이언트는 resume 없이 새로 입장한다 → 첫 입장자가 host로 파일 기준 재시드.
 * 권한: 요청 conn이 현재 ownerConn인지 서버가 직접 확인한다 (clientId 사칭 불가).
 */
export function resetRoomFromDisk(
  roomId: string,
  conn: unknown,
): { ok: true } | { ok: false; reason: 'not_owner' | 'external_change' | 'no_room' } {
  const room = rooms.get(roomId)
  if (!room) return { ok: false, reason: 'no_room' }
  if (room.ownerConn === null || room.ownerConn !== conn) return { ok: false, reason: 'not_owner' }
  const diskHash = room.lastHash
  // C6c-1: 리셋 자체가 미뤄진 파트 변경을 해소한다.
  room.pendingPartReset = null
  clearParentResetTimer(room)
  // 전원 종료 → 재입장. 이 시점에 owner는 접속 중이므로 디스크 == lastHash가 정상.
  noteReset(roomId, room.conns.size)
  for (const ws of [...room.conns.keys()]) {
    try {
      const sock = ws as { close?: (code?: number, reason?: string) => void }
      sock.close?.(CLOSE_ROOM_RESET, 'room_reset')
    } catch {
      // 무시
    }
  }
  disposeRoom(room)
  logger.warn(`Collab room ${roomId}: reset by owner — all conns closed (4001), room disposed (disk=${diskHash})`)
  return { ok: true }
}

/**
 * C5-2: 서버 주도 방 리셋 (문서 첨부 조립 후).
 * resetRoomFromDisk의 owner-conn 확인 없이 수행한다 — 호출자가 이미
 * dirty/viewer 판정을 마친 embed 경로에서만 쓴다.
 * 전원 conn을 4001로 닫고 방을 해체한다. 클라이언트는 resume 없이
 * 새로 입장한다 → 첫 입장자가 새 디스크 바이트 기준으로 재시드.
 */
export function resetRoomByServer(roomId: string, reason = 'embed_reset'): { ok: true } | { ok: false; reason: 'no_room' } {
  const room = rooms.get(roomId)
  if (!room) return { ok: false, reason: 'no_room' }
  // P0-3(C6c-b): 무접속 방도 예전처럼 dispose한다(adopt된 lastHash만 가진
  // 채 방 객체(Y.Doc)가 남으면, 재입장자가 옛 Y 상태를 받아 owner 자동저장으로
  // 덮어쓸 수 있다). 집계에서만 제외한다 — 수행된 리셋은 전부 disruptive다.
  if (room.conns.size > 0) noteReset(roomId, room.conns.size)
  for (const ws of [...room.conns.keys()]) {
    try {
      const sock = ws as { close?: (code?: number, reason?: string) => void }
      sock.close?.(CLOSE_ROOM_RESET, reason)
    } catch {
      // 무시
    }
  }
  disposeRoom(room)
  logger.warn(`Collab room ${roomId}: reset by server (embed) — all conns closed (4001), room disposed (reason=${reason})`)
  return { ok: true }
}

/**
 * U-parent: 대기 중인 flush를 1회만 끝낸다. onlyConn/onlyRequestId가 있으면
 * 둘 다 맞는 응답만 받는다 (B1: 앞선 저장의 완료를 flush 응답으로 오인 금지).
 */
function settlePendingFlush(
  room: CollabRoom,
  result: FlushResult,
  onlyConn?: unknown,
  onlyRequestId?: string,
): boolean {
  const p = room.pendingFlush
  if (!p) return false
  if (onlyConn !== undefined && p.conn !== onlyConn) return false
  if (onlyRequestId !== undefined && p.requestId !== onlyRequestId) return false
  room.pendingFlush = null
  try {
    clearTimeout(p.timer)
  } catch {
    /* 무시 */
  }
  try {
    p.resolve(result)
  } catch {
    /* 무시 */
  }
  return true
}

/**
 * U-parent: clean close(1000)면 "편집 탭이 떨어졌다" 기록을 지운다.
 * 탭을 정상 종료했으면 미저장이 있을 수 없으므로 PUT이 진행돼도 된다.
 * collab.ts onClose에서 코드 1000일 때만 호출한다.
 */
export function clearEditorDropOnCleanClose(roomId: string): void {
  const room = rooms.get(roomId)
  if (room) room.lastEditorDropAt = 0
}

/** U-parent: 지금 저장할 수 있는 편집 conn이 열려 있는가 (flush 대상). */
export function roomHasOpenEditor(roomId: string): boolean {
  const room = rooms.get(roomId)
  if (!room) return false
  for (const ws of room.conns.keys()) {
    try {
      if (connMode(room, ws) === 'view') continue
    } catch {
      continue
    }
    const rs = (ws as unknown as { readyState?: unknown }).readyState
    if (rs === undefined || rs === 1) return true
  }
  return false
}

/** B1: flush 요청 id 발급용 단조 카운터 (프로세스 내 유일). */
let flushSeq = 0

/**
 * U-parent: 부모 방 owner에게 flush(즉시 저장)를 요청한다 (D64).
 * - owner가 열려 있으면 103 {requestId}를 보내고 104 ack(같은 id)를 최대 timeoutMs까지 기다린다.
 * - owner 선출 전이면 최대 3초까지 선출을 기다린다 (재접속 레이스).
 * - owner가 없으면 {ok:false, reason:'no_owner'} — 호출자는 409로 막는다.
 * - 동시 요청은 1개로 합친다 (같은 promise 공유).
 */
export function requestParentFlush(roomId: string, timeoutMs = FLUSH_WAIT_MS): Promise<FlushResult> {
  const room = rooms.get(roomId)
  if (!room) return Promise.resolve({ ok: true, reason: 'no_room' })
  if (room.pendingFlush) return room.pendingFlush.promise
  let resolve!: (r: FlushResult) => void
  const promise = new Promise<FlushResult>((res) => {
    resolve = res
  })
  const requestId = `f${Date.now().toString(36)}${(flushSeq = (flushSeq + 1) % 2176782336).toString(36)}`
  const finish = (r: FlushResult): void => {
    settlePendingFlush(room, r)
  }
  const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs)
  room.pendingFlush = { promise, resolve, timer, conn: null, requestId, requestedAt: Date.now() }
  const sendToOwner = (owner: unknown): void => {
    const rs = (owner as unknown as { readyState?: unknown }).readyState
    if (rs !== undefined && rs !== 1) {
      finish({ ok: false, reason: 'unreachable' })
      return
    }
    try {
      const e = encoding.createEncoder()
      encoding.writeVarUint(e, MSG_FLUSH_REQUEST)
      // B1: 응답 짝짓기용 id를 함께 보낸다.
      encoding.writeVarUint8Array(e, new TextEncoder().encode(JSON.stringify({ requestId, roomId })))
      ;(owner as CollabSocket).send(encoding.toUint8Array(e))
    } catch {
      finish({ ok: false, reason: 'unreachable' })
      return
    }
    const p = room.pendingFlush
    if (p) p.conn = owner
  }
  const startedAt = Date.now()
  const waitOwner = (): void => {
    if (!rooms.has(roomId) || !room.pendingFlush) return
    const owner = room.ownerConn
    if (owner !== null && owner !== undefined && room.conns.has(owner)) {
      sendToOwner(owner)
      return
    }
    if (Date.now() - startedAt > FLUSH_OWNER_WAIT_MS) {
      finish({ ok: false, reason: 'no_owner' })
      return
    }
    setTimeout(waitOwner, 100)
  }
  waitOwner()
  return promise
}

/**
 * C5-2: 방 참가자의 모드 (viewer 거부 판정용).
 * roomParticipants와 같은 규칙: app.mode 우선, 없으면 lib presence role.
 * 상태를 못 찾으면 null (solo/미참가 → 허용).
 */
export function clientRoleInRoom(roomId: string, clientId: number): 'view' | 'edit' | null {
  const room = rooms.get(roomId)
  if (!room) return null
  try {
    const states = room.awareness.getStates() as Map<number, unknown>
    const st = states.get(clientId) as { app?: { mode?: unknown } } | undefined
    if (!st || typeof st !== 'object') return null
    const app = (st as { app?: { mode?: unknown } }).app
    if (app && typeof app === 'object') {
      return app.mode === 'view' ? 'view' : 'edit'
    }
    const lib = readLibPresence(st as Record<string, unknown>)
    if (!lib) return null
    return lib.role === 'viewer' ? 'view' : 'edit'
  } catch {
    return null
  }
}

/**
 * owner 저장 적용. 판정은 서버의 lastHash 기준이다 (클라이언트 baseHash는
 * 진단용으로만 받는다). 디스크가 lastHash와 다르면 409 conflict (자동 병합 없음).
 * room 단위 체인으로 직렬화한다 (S6C).
 * 이미지 손실이 감지되면 저장하지 않고 409 image_loss로 거절한다 (4-0 가드).
 *
 * X1b: `baseHash` 를 주면 **낙관적 잠금**으로 판정한다(PPT 경로와 동일하게 lastHash 기준).
 * XLSX(lib 방) 경로는 owner 개념이 없으므로 checkSave 의 owner/seeded 검사를 건너뛴다.
 */
export async function applySave(
  roomId: string,
  bytes: Uint8Array,
  opts?: { allowImageLoss?: boolean; clientId?: number; baseHash?: string; kind?: RoomKind; flushRequestId?: string; epoch?: string },
): Promise<
  | { newHash: string }
  | { conflict: true; currentHash: string | null; code?: 'conflict' | 'conflict_room' | 'conflict_external' | 'dirty_room' | 'stale_client'; retryable?: boolean }
  | { imageLoss: true; before: { media: number; refs: number }; after: { media: number; refs: number } }
> {
  const room = rooms.get(roomId)
  if (!room) throw { message: 'No such room', statusCode: 404 }
  // X1c: lib 방(xlsx/docx)에서는 baseHash 가 **필수**다. 없으면 잠금이 아예 건너뛰어져
  // 옛 바이트가 늦게 도착해 저장을 덮어쓸 수 있다(P0-3).
  if (isLibRoomKind(opts?.kind) && !opts?.baseHash) {
    throw { message: 'Missing base hash (optimistic lock required)', statusCode: 400, code: 'missing_base_hash' }
  }
  // X2a: 보기 모드(lib viewer) 참가자의 저장은 거부한다(D40 과 같은 원칙).
  // clientId 는 클라이언트가 보고하는 값이라 HTTP 저장의 완전한 보안 경계는 아니다(보고서 참조).
  if (opts && isLibRoomKind(opts.kind) && opts.clientId !== undefined) {
    const role = readLibPresence(room.awareness.getStates().get(opts.clientId) as Record<string, unknown> | undefined)?.role
    if (role === 'viewer') {
      throw { message: 'View-only participant cannot save', statusCode: 403, code: 'view_only' }
    }
  }
  // P0-1c: 파트 저장의 부모 flush 판정은 체인을 잡기 전에 끝낸다.
  // 체인 안에서 flush(최대 8초)를 기다리면 부모 수동·자동 저장이 뒤에 줄서서
  // flush가 굶어 죽는 순환대기가 된다 (U-flush-race: 파트 PUT이 8초씩 두 번
  // 잡으면 부모는 16초간 막히고 attach는 dirty_room으로 끝난다).
  // 체인은 디스크 읽기-검사-쓰기만 직렬화한다. 겹쳐쓰기는 baseHash 잠금 +
  // 쓰기 체인이 막는다 (flush 뒤에 도착한 부모 저장은 stale로 409가 난다).
  // C6c: 파트 방 저장 전에 부모를 깨끗하게 만든다 (PUT /embed와 동일한 순서).
  // 부모에 열린 에디터가 있으면 flush를 강제하고, 미저장이 stranded면 막는다.
  if (room.part) {
    const parentId = roomIdForAbs(room.part.parentAbs)
    const proom = rooms.get(parentId)
    if (proom) {
      if (roomHasOpenEditor(parentId)) {
        const flush = await requestParentFlush(parentId)
        if (!flush.ok) {
          const cur = await currentDiskHash(parentId)
          // retryable: 편집자가 열려 있어 부모가 수렴할 수 있다.
          // 클라이언트는 상한 내 대기 후 1회 재시도한다 (U-dirty-timeout).
          const r: { conflict: true; currentHash: string | null; code: 'dirty_room'; retryable: boolean } = {
            conflict: true,
            currentHash: cur,
            code: 'dirty_room',
            retryable: true,
          }
          return r
        }
      } else if (proom.docDirty || proom.lastEditorDropAt > 0) {
        const cur = await currentDiskHash(parentId)
        // retryable: false — 편집자가 없어 부모가 스스로 수렴하지 않는다.
        // 클라이언트는 상한을 기다리지 말고 즉시 실패한다 (U-close-save).
        const r: { conflict: true; currentHash: string | null; code: 'dirty_room'; retryable: boolean } = {
          conflict: true,
          currentHash: cur,
          code: 'dirty_room',
          retryable: false,
        }
        return r
      }
    }
  }
  const chainKey = parentChainKey(room)
  // P0-1c-2: flush 응답 저장도 체인을 탄다 (우회 없음). P0-1c에서 flush 판정이
  // 체인 밖으로 나갔으므로, 체인은 쓰기 구간만 잡는다. 우회가 남으면 쓰기 구간과
  // 겹쳐 두 부모 저장이 서로의 baseHash 대조를 피해 덮어쓴다.
  // 겹쳐쓰기는 baseHash 잠금 + 쓰기 체인이 막는다. flushRequestId는
  // flush 완료 판정(같은 id의 저장·104 ack)에만 쓴다.
  const prev = saveChains.get(chainKey) ?? Promise.resolve()
  const run = prev.then(async () => {
    const disk = await currentDiskHash(roomId)
    // C6c-e(P0): 리셋을 넘어온 옛 저장은 막는다. baseHash는 리셋 전후로 같을 수
    // 있지만(M: 미뤄진 병합 저장의 해시 = 리셋 후 방 해시), 방 세대(epoch)가
    // 바뀌었으면 클라이언트가 옛 바이트(옛 첨부)를 들고 있다. 409 stale_client —
    // 재시도 금지, 다시 불러와야 한다 (P0-2 "epoch 불필요" 판단 정정: 미뤄진
    // 리셋에서는 lastHash가 같아도 바이트가 다르다).
    // 파트 방은 제외한다 (파트 내용은 부모 리셋과 무관하고 base 대조로 충분).
    if (!room.part && opts?.epoch) {
      const live = rooms.get(roomId)
      if (live && live.epoch !== opts.epoch) {
        logger.warn(
          `Collab room ${roomId.slice(0, 8)}: save stale_client (epoch ${opts.epoch.slice(0, 8)} != room ${live.epoch.slice(0, 8)})`,
        )
        const r: { conflict: true; currentHash: string | null; code: 'stale_client' } = {
          conflict: true,
          currentHash: live.lastHash,
          code: 'stale_client',
        }
        return r
      }
    }
    // X1b(P0-3/P0-4): 낙관적 잠금. lib 방(xlsx/docx)은 기존대로, P0-2부터
    // PPT 방도 baseHash가 있으면 방 해시와 대조한다 (낡은 탭의 덮어쓰기 차단).
    // baseHash가 없으면 기존 디스크 판정만 유지한다 (하위 호환).
    // epoch 대조는 위 stale_client 게이트에서 한다: 미뤄진 리셋 뒤에는 lastHash가
    // 같아도 바이트가 다를 수 있어 baseHash 대조만으로는 부족하다 (C6c-e).
    // 1) baseHash 가 방의 현재 해시와 다르면 → 방이 앞서갔다(다른 참가자가 먼저 저장).
    //    클라이언트는 방 상태를 다시 직렬화해 1회 재시도한다(모두 같은 방 상태를 갖고 있다).
    // 2) 디스크가 방의 해시와 다르면 → 외부 변경(AI 편집·보기 모드 코멘트).
    //    재시도하지 않는다(덮어쓰면 조용한 유실이 된다).
    if (isLibRoomKind(opts?.kind) || opts?.kind === 'pptx') {
      // C6c-d-1: 미뤄진 변경이 있는 부모 방이면 adopt 전 해시도 받아준다.
      // 타이핑 중이던 클라이언트는 옛 파트를 든 바이트를 들고 있으므로, base가
      // adopt 전 해시여도 병합 저장한다 (아래에서 디스크 파트를 다시 끼운다).
      // C7: 백그라운드 삽입 직전 해시도 받아준다 (삽입을 모르는
      // 클라이언트의 저장이 409 없이 병합된다).
      // C7b: 1회 무료 패스는 clientId 집합으로 관리한다. 같은 옛 base라도
      // 아직 저장 안 한 clientId는 1회 받아준다 (두 번째 타이피스트 409 방지).
      // 허용 집합에 없는 base는 기존대로 conflict_room이다 (다른 타이피스트 보호).
      const deferBases = !room.part ? room.pendingPartReset?.bases : undefined
      const knownBases = !room.part ? room.knownEmbeds.map((e) => e.preHash).filter((h): h is string => !!h) : undefined
      const cid = opts?.clientId
      const inKnown = !!knownBases && !!opts?.baseHash && knownBases.includes(opts.baseHash)
      // 무료 패스 사용済면 같은 옛 base라도 거부한다.
      const passUsed = cid !== undefined && room.embedPassUsed.has(cid)
      if (opts?.baseHash && opts.baseHash !== room.lastHash) {
        if ((!deferBases || !deferBases.includes(opts.baseHash)) && (!inKnown || passUsed)) {
          logger.warn(
            `Collab room ${room.id}: save conflict_room (base ${opts.baseHash.slice(0, 8)} != room ${room.lastHash.slice(0, 8)})`,
          )
          const r: { conflict: true; currentHash: string | null; code: 'conflict_room' } = {
            conflict: true,
            currentHash: room.lastHash,
            code: 'conflict_room',
          }
          return r
        }
      }
      if (disk !== room.lastHash) {
        const known = room.recentSaveHashes.includes(disk ?? '')
        room.externalChanged = true
        broadcastMeta(room)
        const r: { conflict: true; currentHash: string | null; code: 'conflict_room' | 'conflict_external' } = {
          conflict: true,
          currentHash: disk,
          code: known ? 'conflict_room' : 'conflict_external',
        }
        logger.warn(`Collab room ${room.id}: save conflict (${r.code}) disk=${String(disk).slice(0, 8)} room=${room.lastHash.slice(0, 8)}`)
        return r
      }
    }
    if (disk !== room.lastHash) {
      room.externalChanged = true
      broadcastMeta(room)
      const r: { conflict: true; currentHash: string | null } = { conflict: true, currentHash: disk }
      return r
    }
    // C7: 백그라운드 삽입 보존 — 들어온 바이트에 없는 known 파트를 디스크
    // 기준으로 같은 위치에 다시 조립한다. 이미지 가드보다 먼저
    // (삽입 미리보기 PNG가 없으면 가드가 오작동한다). 미뤄진 adopt 교체는
    // 그 다음에 얹는다 (이미 있는 파트의 새 바이트 교체).
    let knownMerged = bytes
    if (!room.part && room.knownEmbeds.length > 0) {
      knownMerged = await ensureKnownEmbeds(room, bytes)
    }
    // 4-0 가드: pptx 저장에서 이미지(파트·관계)가 줄었으면 막는다.
    // 명시적 승인(allowImageLoss)이 있을 때만 통과한다.
    // C6c: 파트 방은 부모 확장자가 아니라 파트 파일명으로 판정한다.
    const imageSubject = room.part ? room.part.part.split('/').pop() ?? '' : room.path
    if (!opts?.allowImageLoss && /\.pptx$/i.test(imageSubject)) {
      const before = await diskImageCounts(room)
      const after = countPptxImages(knownMerged)
      if (before && after && (after.media < before.media || after.refs < before.refs)) {
        logger.warn(
          `Collab room ${room.id}: image loss blocked (media ${before.media}->${after.media}, refs ${before.refs}->${after.refs})`,
        )
        const r: {
          imageLoss: true
          before: { media: number; refs: number }
          after: { media: number; refs: number }
        } = { imageLoss: true, before, after }
        return r
      }
    }
    room.saving = true
    // C6c-d-1: 미뤄진 변경이 있는 부모 방이면 디스크의 adopt 파트를 들어온
    // 부모 zip에 다시 끼워 쓴다. 들어온 바이트가 옛 파트를 들고 있어도
    // 디스크의 새 첨부가 보존되고, 부모의 편집도 함께 남는다.
    const deferMerge = !room.part ? room.pendingPartReset : null
    let finalBytes = knownMerged
    if (deferMerge && deferMerge.parts.length > 0) {
      finalBytes = await reembedAdoptedParts(room, knownMerged)
    }
    const newHash = hashBytes(finalBytes)
    // M10/D37: rename **전에** 해시를 대기 목록에 넣는다.
    // watcher 가 rename 이벤트를 받아도 이 해시로 자기 저장임을 확인할 수 있다.
    room.pendingHashes.push(newHash)
    if (room.pendingHashes.length > 3) room.pendingHashes.shift()
    // C6c: 파트 방 저장은 부모 zip 안 파트를 교체한다 (PUT /embed와 동일).
    // 부모 zip·해시는 즉시 adopt하고, 방 리셋은 조용한 구간까지 미룰 수 있다
    // (C6c-1: 열린 편집자의 타이핑을 4001로 끊지 않는다).
    try {
      if (room.part) {
        const parentAbs = room.part.parentAbs
        const norm = normalizeEmbedPart(room.part.part)
        const hostBytes = new Uint8Array(await fs.readFile(parentAbs))
        const out = await replaceEmbedPart(zipLoadJSZip, hostBytes, norm, bytes)
        await writeFileContent(parentAbs, Buffer.from(out))
        const parentId = roomIdForAbs(parentAbs)
        // C6c-1: 부모 zip은 즉시 반영하고, 방 리셋은 부모가 조용할 때까지 미룰 수 있다
        // (열린 편집자의 타이핑을 4001로 끊지 않는다).
        adoptParentPartAndMaybeReset(parentId, hashBytes(out), norm)
      } else {
        await writeFileContent(room.path, Buffer.from(finalBytes))
      }
    } finally {
      room.saving = false
    }
    room.lastHash = newHash
    // C6c-d-1: 미뤄진 동안의 부모 저장은 base를 1회성으로 소비한다.
    // 쓴 base를 집합에서 빼고 새 병합 해시를 넣는다: 같은 타이피스트의 연속
    // 저장은 이어지고, 묵은 base의 다른 타이피스트는 409가 난다 (편집 보호).
    // 미뤄짐 자체는 유지한다 (클라이언트는 아직 옛 파트를 들고 있음).
    if (deferMerge) {
      const d2 = room.pendingPartReset
      if (d2) {
        if (opts?.baseHash) d2.bases = d2.bases.filter((b) => b !== opts.baseHash)
        if (!d2.bases.includes(newHash)) d2.bases.push(newHash)
        if (d2.bases.length > 8) d2.bases = d2.bases.slice(-8)
      }
    }
    // C7b: clientId별 1회 무료 패스 소비 (같은 옛 base 재사용은 409).
    // id 없는 저장은 기존대로 preHash를 소비한다.
    if (!room.part && room.knownEmbeds.length > 0 && opts?.baseHash) {
      if (opts.clientId !== undefined) {
        room.embedPassUsed.add(opts.clientId)
      } else {
        for (const ke of room.knownEmbeds) {
          if (ke.preHash === opts.baseHash) ke.preHash = null
        }
      }
    }
    // B3: 저장 성공 — 미저장 표시를 지운다.
    room.docDirty = false
    room.lastSaveAt = Date.now()
    // B1: 대기 중인 flush가 있고, 이 저장이 flush 요청 이후의 원격 업데이트를
    // 모두 포함한 것이 확실할 때만 끝낸다 (저장 이후 도착한 업데이트가 있으면
    // ack 경로의 신선 저장을 기다린다 — 낡은 바이트 확정 금지).
    // 같은 동기 블록이라 사이에 업데이트가 끼어들 수 없다.
    // P0-1: 짝이 맞는 flush 응답 저장은 항상 끝낸다. 짝이 안 맞아도, 요청보다
    // 늦게 끝나고 원격 업데이트를 모두 포함하면 끝낸다 (진행 중이던 저장이
    // flush 응답을 겸하는 경우 — 막으면 교착으로 dirty_room이 된다).
    if (
      room.pendingFlush &&
      room.lastRemoteUpdateAt <= room.lastSaveAt &&
      (opts?.flushRequestId === room.pendingFlush.requestId ||
        room.pendingFlush.requestedAt <= room.lastSaveAt)
    ) {
      settlePendingFlush(room, { ok: true, reason: 'saved' })
    }
    // M25 5번: 계측은 **저장 성공 후**에 찍는다(실패해도 "ok" 가 남으면 안 된다).
    // 레벨: warn — 이 로그는 E2E 저장경로 표를 만드는 계측용이며, 테스트 환경의 기본
    // 로그 레벨(warn 이상)에서만 보인다(info 로 낮추면 Playwright webServer 출력에 안 나온다).
    logger.warn(
      `[applySave] room=${roomId.slice(0, 8)} b=${finalBytes.length} cid=${opts?.clientId ?? '?'} h=${newHash.slice(0, 8)} at=${Date.now()}`,
    )
    // M12 계측: 저장 실물 기록(바이트 수/해시/시각).
    logger.info(
      `Collab room ${roomId}: applySave ok bytes=${bytes.length} newHash=${newHash.slice(0, 12)} at=${Date.now()}`,
    )
    // rename 이 끝났고 lastHash 가 갱신되었으므로 대기 해시는 제거한다.
    room.pendingHashes = room.pendingHashes.filter((h) => h !== newHash)
    // X1b: 이 방이 직접 저장한 해시를 기억한다(최근 5개).
    // "디스크 해시가 이 목록에 있음" = 이 방의 참가자가 먼저 저장한 것 → conflict_room.
    room.recentSaveHashes.push(newHash)
    if (room.recentSaveHashes.length > 5) room.recentSaveHashes.shift()
    room.externalChanged = false
    // C6c: 이미지 계측 캐시는 파트 방이면 파트 파일 기준으로 갱신한다.
    // C6c-d-1: 미뤄진 병합 저장은 병합 바이트 기준으로 갱신한다.
    const imageSubject2 = room.part ? room.part.part.split('/').pop() ?? '' : room.path
    if (/\.pptx$/i.test(imageSubject2)) room.lastImageCounts = countPptxImages(finalBytes)
    broadcastMeta(room)
    const r: { newHash: string } = { newHash: newHash }
    return r
  })
  saveChains.set(chainKey, run.then(
    () => undefined,
    () => undefined,
  ))
  return run
}

/**
 * H2: app.where는 클라이언트가 임의로 넣는 문자열이라 그대로 신뢰하지 않는다.
 * 문자열이 아니면 버리고, 제어문자를 제거하고 64자로 자른다.
 */
function sanitizeWhere(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[ -]/g, '').trim()
  if (!cleaned) return undefined
  return cleaned.slice(0, 64)
}

/** awareness에서 참가자 목록을 읽는다 (서버는 읽기만, publish 금지). */
export function roomParticipants(room: CollabRoom): CollabParticipant[] {
  const out: CollabParticipant[] = []
  try {
    const states = room.awareness.getStates() as Map<number, {
      app?: { id?: string; name?: string; color?: string; mode?: string; slide?: number; where?: string }
      userName?: string
    }>
    for (const [cid, st] of states) {
      const app = st?.app
      if (!app || typeof app !== 'object') {
        // X2a: XLSX(lib)는 app 대신 presence 키로 알린다. 형식이 틀리면 readLibPresence 가 null.
        const lib = readLibPresence(st as unknown as Record<string, unknown>)
        if (!lib) continue
        out.push({
          id: lib.userId ?? String(cid),
          name: lib.name,
          color: lib.color,
          mode: lib.role === 'viewer' ? 'view' : 'edit',
          owner: room.ownerIds.has(cid),
          userId: lib.userId,
        })
        continue
      }
      // 슬라이드는 app.slide(클라이언트가 게시한 값)만 쓴다.
      // lib presence의 activeSlideIndex는 0 고정 + 10초 재게시라 항상 1번이라 fallback 불가.
      const appSlide = typeof app.slide === 'number' && app.slide >= 1 ? app.slide : undefined
      out.push({
        id: String(app.id ?? cid),
        name: String(app.name ?? st.userName ?? `user-${cid}`),
        color: String(app.color ?? '#6366f1'),
        mode: app.mode === 'view' ? 'view' : 'edit',
        slide: appSlide,
        // 공통 위치 표기(app.where)를 그대로 전달한다 (클라 표시 단일 출처).
        // H2: 클라이언트가 임의로 넣는 문자열이므로 64자로 자르고 제어문자를 뺀다.
        // 조건에 안 맞으면 undefined로 두어 표시되지 않게 한다.
        where: sanitizeWhere(app.where),
        owner: room.ownerIds.has(cid),
      })
    }
    // 2-2: 같은 user.id는 하나로 합친다. owner > edit > view 우선순위,
    // 같은 등급이면 먼저 본(추가된) 항목을 유지한다.
    const byId = new Map<string, CollabParticipant>()
    for (const p of out) {
      const prev = byId.get(p.id)
      if (!prev) {
        byId.set(p.id, p)
        continue
      }
      const rank = (x: CollabParticipant): number => (x.mode === 'edit' ? 1 : 0) + (x.owner ? 2 : 0)
      byId.set(p.id, rank(p) > rank(prev) ? p : prev)
    }
    return [...byId.values()]
  } catch { /* 무시 */ }
  return out
}

/** edit 모드 참가자가 한 명이라도 있는가. 모르면 edit 취급 (하위 호환). */
export function roomHasEditors(room: CollabRoom): boolean {
  if (room.conns.size === 0) return false
  for (const ws of room.conns.keys()) {
    if (connMode(room, ws) !== 'view') return true
  }
  return false
}

export interface LockInfo {
  active: boolean
  /** conns는 0이지만 최근 편집 흔적이 있어 재연결 대기 중 (F). */
  reconnecting?: boolean
  roomId?: string
  owner?: number[]
  epoch?: string
  lastHash?: string
  seeded?: boolean
  externalChanged?: boolean
  participants?: CollabParticipant[]
  /** 마지막 AI 차단(409) 시각(ms). 칩 표시용으로 그대로 노출한다. */
  aiBlockedAt?: number | null
}

/**
 * AI 편집 차단 + 외부변경 배너 + knownHash 갱신용 조회. 조용히 inactive를 돌려준다.
 * V5: edit 참가자가 있을 때만 active. poll마다 파일을 hash하지 않는다.
 */
export async function lockInfo(userPath: string): Promise<LockInfo> {
  let abs: string | null = null
  try {
    abs = await resolveWorkspaceFile(String(userPath ?? ''))
  } catch {
    return { active: false }
  }
  if (!abs) return { active: false }
  const id = pathIndex.get(normalizeAbs(abs)) ?? roomIdForAbs(abs)
  const room = rooms.get(id)
  if (!room || room.conns.size === 0) {
    // F: conns가 0이어도 everConnected + TTL 안이면 재연결 대기로 알린다.
    // AI는 이 동안 편집하지 않는다 (409 유지).
    if (room && room.everConnected && room.emptySince !== null && Date.now() - room.emptySince < roomTtlMs) {
      return {
        active: true,
        reconnecting: true,
        roomId: id,
        epoch: room.epoch,
        lastHash: room.lastHash,
        participants: [],
        aiBlockedAt: room.aiBlockedAt,
      }
    }
    return { active: false }
  }
  // view-only room도 참가자바용으로 participants는 돌려준다 (active는 edit 있을 때만).
  if (!roomHasEditors(room)) {
    return { active: false, roomId: id, participants: roomParticipants(room), aiBlockedAt: room.aiBlockedAt }
  }
  return {
    active: true,
    roomId: id,
    owner: [...room.ownerIds],
    epoch: room.epoch,
    lastHash: room.lastHash,
    seeded: room.seeded,
    externalChanged: room.externalChanged,
    participants: roomParticipants(room),
    aiBlockedAt: room.aiBlockedAt,
  }
}

/** 활성 room 목록 (탐색기 아바타용, 10초 poll). */
export interface RoomSummary {
  roomId: string
  path: string
  /** workspace 상대경로 (탐색기 file.path 매칭용). */
  rel: string
  epoch: string
  participants: CollabParticipant[]
  /** X2a-③: 방에 문서가 올라왔는가. viewer가 리마운트 시점을 정할 때 쓴다. */
  seeded: boolean
  /** C6c: 하위문서 방의 파트 경로 (파일 방이면 undefined). */
  part?: string
  /** P0-3: 방 리셋 빈도 (없으면 리셋된 적 없음). */
  resets?: RoomResetStats
}

export function listRooms(): RoomSummary[] {
  const out: RoomSummary[] = []
  const root = workspaceRootAbs()
  for (const room of rooms.values()) {
    if (room.conns.size === 0) continue
    out.push({
      roomId: room.id,
      path: room.path,
      rel: path.relative(root, room.path).replace(/\\/g, '/'),
      epoch: room.epoch,
      participants: roomParticipants(room),
      seeded: room.seeded,
      part: room.part?.part,
      resets: resetStatsMap.get(room.id),
    })
  }
  return out
}

/** 테스트용 리셋. */
export function resetCollabForTests(): void {
  for (const room of [...rooms.values()]) disposeRoom(room)
  rooms.clear()
  pathIndex.clear()
  saveChains.clear()
  resetStatsMap.clear()
  roomTtlMs = 30_000
  parentQuietMs = 5000
  parentResetMaxMs = 60_000
}

// ---------------------------------------------------------------------------
// C4: 시트 개체(그림·도형·차트·EMB) 표·락·이동/삭제
//
// 원칙:
// - 키는 서버가 발급한다(`o1`, `o2`, …). image/chart는 lib에 안정 식별자가 없어
//   cNvPr id를 쓰지 않는다(저장할 때마다 다시 매겨진다 — 0절 실측).
// - 해시별 시트 순서를 기록한다. 같은 해시는 같은 바이트이므로 순서가 같아야 한다.
//   다르면 키를 붙이지 않고 fail-closed(그 세션의 개체 op 전부 잠금).
// - 락은 10초 임대, move와 같은 lockId로 갱신된다. WS close·awareness 소멸 시 즉시 해제.
// - 변경은 방 전체에 type 102 WS 메시지로 알린다 (lib은 모르는 타입을 무시한다).
// - 방 리셋·해제는 room 객체와 함께 표를 버린다 (별도 정리 불필요).
// ---------------------------------------------------------------------------

export interface RoomObjectSnapshot {
  key: string
  sheet: number
  kind: string
  anchor: unknown
  deleted: boolean
  version: number
  lock: { clientId: number; lockId: string; expiresAt: number } | null
}

export interface RoomObjectsState {
  version: number
  order: Record<string, string[]> | null
  objects: RoomObjectSnapshot[]
}

/** EMB 계열: 이동·삭제 모두 잠금 (1단계). */
function isEmbKind(kind: string): boolean {
  return kind === 'unsupported:object'
}

function snapshotEntry(e: RoomObjectEntry): RoomObjectSnapshot {
  return {
    key: e.key,
    sheet: e.sheet,
    kind: e.kind,
    anchor: e.anchor,
    deleted: e.deleted,
    version: e.version,
    lock: e.lock ? { ...e.lock } : null,
  }
}

/** 만료된 락을 정리한다. true면 바뀐 것이 있다. */
export function sweepObjectLocks(room: CollabRoom, now: number = Date.now()): boolean {
  let changed = false
  for (const e of room.objects.byKey.values()) {
    if (e.lock && e.lock.expiresAt <= now) {
      e.lock = null
      changed = true
    }
  }
  return changed
}

function broadcastObjects(room: CollabRoom): void {
  broadcast(room, encodeObjects(room))
}

/** 102 페이로드 인코딩 (addConn 즉시 전송과 브로드캐스트가 공유한다). */
function encodeObjects(room: CollabRoom): Uint8Array {
  const e = encoding.createEncoder()
  encoding.writeVarUint(e, MSG_ROOM_OBJECTS)
  encoding.writeVarUint8Array(e, new TextEncoder().encode(JSON.stringify(getRoomObjects(room.id))))
  return encoding.toUint8Array(e)
}

/** 방 개체 전체 상태 (GET / session 응답용). */
export function getRoomObjects(roomId: string): (RoomObjectsState & { roomId: string }) | { error: string; code: string } {
  const room = rooms.get(roomId)
  if (!room) return { error: 'No such room', code: 'no_room' }
  sweepObjectLocks(room)
  return {
    roomId,
    version: room.objects.version,
    order: room.objects.orderByHash.get(room.lastHash) ?? null,
    objects: [...room.objects.byKey.values()].map(snapshotEntry),
  }
}

/**
 * 개체 등록. 첫 등록자가 시트별 kinds를 보내면 서버가 키를 발급한다.
 * 이미 아는 해시면 순서·개수를 대조하고, 다르면 키 없이 거부한다 (fail-closed).
 */
export function registerRoomObjects(
  roomId: string,
  hash: string,
  items: Array<{ sheet: number; kind: string }>,
):
  | { ok: true; keys: string[]; version: number; objects: RoomObjectSnapshot[]; order: Record<string, string[]> }
  | { ok: false; code: 'no_room' | 'order_mismatch'; version?: number; objects?: RoomObjectSnapshot[]; expected?: Record<string, string[]> } {
  const room = rooms.get(roomId)
  if (!room) return { ok: false, code: 'no_room' }
  if (typeof hash !== 'string' || !hash || !Array.isArray(items) || items.length > 500) {
    return { ok: false, code: 'order_mismatch' }
  }
  for (const it of items) {
    if (!it || !Number.isInteger(it.sheet) || it.sheet < 0 || typeof it.kind !== 'string' || !it.kind || it.kind.length > 80) {
      return { ok: false, code: 'order_mismatch' }
    }
  }
  const keyOf = (sheet: number, kind: string): string => `${sheet}::${kind}`
  const sigOfCounts = (m: ReadonlyMap<string, number>): string =>
    JSON.stringify([...m.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  const liveCountsOf = (ord: Record<string, string[]>): Map<string, number> => {
    const liveCounts = new Map<string, number>()
    for (const sk of Object.keys(ord)) {
      for (const k of ord[sk] ?? []) {
        const e = room.objects.byKey.get(k)
        if (!e || e.deleted) continue
        const kk = keyOf(e.sheet, e.kind)
        liveCounts.set(kk, (liveCounts.get(kk) ?? 0) + 1)
      }
    }
    return liveCounts
  }
  const gotCounts = new Map<string, number>()
  for (const it of items) {
    const kk = keyOf(it.sheet, it.kind)
    gotCounts.set(kk, (gotCounts.get(kk) ?? 0) + 1)
  }
  let existing = room.objects.orderByHash.get(hash)
  if (!existing) {
    // C4: 같은 순서(signature)면 해시가 달라도 같은 키를 재사용한다.
    // lib 직렬화물은 바이트만 달라지고 개체 순서는 그대로라서, 해시마다
    // 키를 새로 발급하면 참가자끼리 키가 어긋나 잠금·이동이 빗나간다.
    const gotSig = sigOfCounts(gotCounts)
    for (const ord of room.objects.orderByHash.values()) {
      if (sigOfCounts(liveCountsOf(ord)) === gotSig) {
        existing = ord
        room.objects.orderByHash.set(hash, ord)
        break
      }
    }
  }
  if (existing) {
    const liveCounts = liveCountsOf(existing)
    const liveOrder: Record<string, string[]> = {}
    for (const sk of Object.keys(existing)) {
      liveOrder[sk] = []
      for (const k of existing[sk] ?? []) {
        const e = room.objects.byKey.get(k)
        if (!e || e.deleted) continue
        liveOrder[sk].push(k)
      }
    }
    let okOrder = gotCounts.size === liveCounts.size
    if (okOrder) {
      for (const [k, n] of gotCounts) {
        if (liveCounts.get(k) !== n) {
          okOrder = false
          break
        }
      }
    }
    if (!okOrder) {
      logger.warn(`Collab room ${roomId}: objects order mismatch for hash ${hash.slice(0, 12)} (fail-closed)`)
      return { ok: false, code: 'order_mismatch', version: room.objects.version, objects: [...room.objects.byKey.values()].map(snapshotEntry), expected: existing }
    }
    const keys: string[] = []
    for (const sk of Object.keys(liveOrder).sort((a, b) => Number(a) - Number(b))) keys.push(...(liveOrder[sk] ?? []))
    return { ok: true, keys, version: room.objects.version, objects: [...room.objects.byKey.values()].map(snapshotEntry), order: existing }
  }
  const keys: string[] = []
  const order: Record<string, string[]> = {}
  for (const it of items) {
    const key = `o${++room.objects.seq}`
    keys.push(key)
    const sk = String(it.sheet)
    if (!order[sk]) order[sk] = []
    order[sk].push(key)
    room.objects.byKey.set(key, {
      key,
      sheet: it.sheet,
      kind: it.kind,
      anchor: null,
      deleted: false,
      version: room.objects.version,
      lock: null,
    })
  }
  room.objects.orderByHash.set(hash, order)
  broadcastObjects(room)
  return { ok: true, keys, version: room.objects.version, objects: [...room.objects.byKey.values()].map(snapshotEntry), order }
}

function liveLock(e: RoomObjectEntry, now: number): boolean {
  return !!e.lock && e.lock.expiresAt > now
}

/**
 * 개체 락 요청. 같은 홀더의 재요청은 갱신(같은 lockId 반환)한다.
 */
export function acquireObjectLock(
  roomId: string,
  key: string,
  clientId: number,
  now: number = Date.now(),
  ttlMs: number = OBJECT_LOCK_TTL_MS,
): { ok: true; lockId: string; expiresAt: number; version: number } | { ok: false; code: string; holder?: number; version?: number } {
  const room = rooms.get(roomId)
  if (!room) return { ok: false, code: 'no_room' }
  const e = room.objects.byKey.get(key)
  if (!e || e.deleted) return { ok: false, code: 'gone' }
  if (!Number.isInteger(clientId)) return { ok: false, code: 'bad_client' }
  if (sweepObjectLocks(room, now)) broadcastObjects(room)
  if (e.lock && liveLock(e, now)) {
    if (e.lock.clientId === clientId) {
      e.lock.expiresAt = now + ttlMs
      broadcastObjects(room)
      return { ok: true, lockId: e.lock.lockId, expiresAt: e.lock.expiresAt, version: room.objects.version }
    }
    return { ok: false, code: 'locked', holder: e.lock.clientId, version: room.objects.version }
  }
  const lockId = randomUUID()
  e.lock = { clientId, lockId, expiresAt: now + ttlMs }
  broadcastObjects(room)
  return { ok: true, lockId, expiresAt: e.lock.expiresAt, version: room.objects.version }
}

/** 개체 락 해제. 정확히 같은 lockId일 때만 푼다. */
export function releaseObjectLock(
  roomId: string,
  key: string,
  lockId: string,
): { ok: true } | { ok: false; code: string } {
  const room = rooms.get(roomId)
  if (!room) return { ok: false, code: 'no_room' }
  const e = room.objects.byKey.get(key)
  if (!e) return { ok: false, code: 'gone' }
  if (!e.lock) return { ok: true }
  if (e.lock.lockId !== lockId) return { ok: false, code: 'not_holder' }
  e.lock = null
  broadcastObjects(room)
  return { ok: true }
}

/**
 * 주어진 awareness clientId들을 홀더로 하는 락을 모두 푼다.
 * WS close(→removeAwarenessStates→'update' removed)와 순수 awareness 소멸 모두
 * createRoom 의 awareness 'update' 핸들러를 거쳐 여기로 온다.
 */
export function releaseObjectLocks(room: CollabRoom, clientIds: number[]): boolean {
  let changed = false
  const gone = new Set(clientIds)
  for (const e of room.objects.byKey.values()) {
    if (e.lock && gone.has(e.lock.clientId)) {
      e.lock = null
      changed = true
    }
  }
  if (changed) {
    logger.info(`Collab room ${room.id}: object locks released on disconnect (${clientIds.length} cids)`)
    broadcastObjects(room)
  }
  return changed
}

function checkObjectVersion(
  room: CollabRoom,
  baseVersion: unknown,
): { ok: true } | { ok: false; code: 'version_mismatch'; version: number; objects: RoomObjectSnapshot[] } {
  if (baseVersion !== room.objects.version) {
    return {
      ok: false,
      code: 'version_mismatch',
      version: room.objects.version,
      objects: [...room.objects.byKey.values()].map(snapshotEntry),
    }
  }
  return { ok: true }
}

/**
 * move/delete 공통 판정. lockId가 있으면 검증·갱신하고, 없으면
 * 다른 홀더가 없을 때 호출자에게 즉시 락을 건다(grant-on-write).
 */
function checkObjectWrite(
  room: CollabRoom,
  e: RoomObjectEntry,
  clientId: number,
  lockId: string | undefined,
  now: number,
):
  | { ok: true }
  | { ok: false; code: 'locked' | 'not_holder'; holder?: number; version: number; objects: RoomObjectSnapshot[] } {
  sweepObjectLocks(room, now)
  const stale = (code: 'locked' | 'not_holder', holder?: number) => ({
    ok: false as const,
    code,
    holder,
    version: room.objects.version,
    objects: [...room.objects.byKey.values()].map(snapshotEntry),
  })
  if (e.lock && liveLock(e, now)) {
    if (lockId !== undefined) {
      if (e.lock.lockId !== lockId || e.lock.clientId !== clientId) return stale('not_holder', e.lock.clientId)
      e.lock.expiresAt = now + OBJECT_LOCK_TTL_MS
      return { ok: true }
    }
    if (e.lock.clientId === clientId) {
      e.lock.expiresAt = now + OBJECT_LOCK_TTL_MS
      return { ok: true }
    }
    return stale('locked', e.lock.clientId)
  }
  if (lockId !== undefined) return stale('not_holder')
  // grant-on-write: 다른 홀더가 없으면 호출자에게 즉시 락을 건다.
  e.lock = { clientId, lockId: randomUUID(), expiresAt: now + OBJECT_LOCK_TTL_MS }
  return { ok: true }
}

function applyObjectChange(
  roomId: string,
  key: string,
  clientId: number,
  baseVersion: unknown,
  lockId: string | undefined,
  apply: (e: RoomObjectEntry) => void,
  now: number = Date.now(),
):
  | { ok: true; version: number }
  | { ok: false; code: string; holder?: number; version?: number; objects?: RoomObjectSnapshot[] } {
  const room = rooms.get(roomId)
  if (!room) return { ok: false, code: 'no_room' }
  const e = room.objects.byKey.get(key)
  if (!e) return { ok: false, code: 'gone' }
  if (e.deleted && apply !== deleteApply) return { ok: false, code: 'deleted' }
  if (!Number.isInteger(clientId)) return { ok: false, code: 'bad_client' }
  // C4 1단계: EMB(surgical oleObj)는 이동·삭제 모두 잠금. 혼자 편집할 때도 막는다.
  if (isEmbKind(e.kind)) return { ok: false, code: 'emb_locked', version: room.objects.version }
  const vc = checkObjectVersion(room, baseVersion)
  if (!vc.ok) return vc
  const wc = checkObjectWrite(room, e, clientId, lockId, now)
  if (!wc.ok) return wc
  apply(e)
  room.objects.version += 1
  e.version = room.objects.version
  broadcastObjects(room)
  return { ok: true, version: room.objects.version }
}

const deleteApply = (e: RoomObjectEntry): void => {
  e.deleted = true
}

/** 개체 이동. anchor는 서버가 파싱하지 않고 그대로 저장·방송한다. */
export function moveObject(
  roomId: string,
  key: string,
  clientId: number,
  anchor: unknown,
  baseVersion: unknown,
  lockId?: string,
  now: number = Date.now(),
):
  | { ok: true; version: number }
  | { ok: false; code: string; holder?: number; version?: number; objects?: RoomObjectSnapshot[] } {
  if (anchor === undefined || anchor === null || typeof anchor !== 'object') {
    return { ok: false, code: 'bad_anchor' }
  }
  return applyObjectChange(roomId, key, clientId, baseVersion, lockId, (e) => {
    e.anchor = anchor
  }, now)
}

/** 개체 삭제. */
export function deleteObject(
  roomId: string,
  key: string,
  clientId: number,
  baseVersion: unknown,
  lockId?: string,
  now: number = Date.now(),
):
  | { ok: true; version: number }
  | { ok: false; code: string; holder?: number; version?: number; objects?: RoomObjectSnapshot[] } {
  return applyObjectChange(roomId, key, clientId, baseVersion, lockId, deleteApply, now)
}
