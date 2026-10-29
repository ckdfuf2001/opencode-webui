import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Loader2, RefreshCw, Reply, Pencil, Check, RotateCcw, Trash2, X, Eye } from 'lucide-react'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { translationsEn } from 'pptx-react-viewer/i18n'
import 'pptx-react-viewer/styles.css'
import { Button } from '@/components/ui/button'
import { saveOfficeBytes } from './officeSave'
import { showToast } from '@/lib/toast'
import { PptxViewerBoundary } from './ViewerBoundaries'
import { lazyWithRetry } from './lazyRetry'

const PowerPointViewer = lazyWithRetry(() =>
  import('pptx-react-viewer').then((m) => ({ default: m.PowerPointViewer })),
)
import { loadPptxComments, type PptxComment } from './pptxComments'
import { createSaveSerializer, type SaveSerializer } from '@/lib/saveSerializer'
import { addPptxComment, replyPptxComment, setPptxCommentDone, editPptxComment, deletePptxComment } from './pptxCommentWriter'
import { collabApi, collabServerUrl, type ImageLossDetail } from '@/api/collab'
import { YCollabSession, buildCollaborationConfig, COLLAB_PALETTE, formatWhere } from '@/lib/ycollab'
import { useCollabUser } from '@/lib/collabUser'
import { usePeers, type Peer } from '@/lib/usePeers'
import { CollabPeerChip, CollabPresenceShell, CollabSelfMarker, NowProvider } from '@/components/collab/CollabPresence'
import { useMobile } from '@/hooks/useMobile'
import { useTheme } from '@/hooks/useTheme'
import { pptxThemeColors } from './viewerTheme'
import { countPptxDocImages, ensurePptxImagesSyncable } from '@/lib/pptxImageSync'
import { createSlideGate } from '@/lib/slideLocationGate'
import { decideSaveIntent, type OwnerState } from '@/lib/collabSaveIntent'
import { acquireCollabSession, collabSessionCount, dropCollabSession } from '@/lib/collabSessionRegistry'
import { tl, tlDump } from '@/lib/collabTimeline'

// lib이 그림을 blob: URL로 만들면 Y.Doc 동기화 때 죽는다. data: URL로 고정.
ensurePptxImagesSyncable()

// 2-1: lib 내장 공유/아바타 UI를 끈다 — 참가자 표시는 우리 상단 바가 단일 통로다.
const PPT_CUSTOMIZATION = { hiddenDialogs: ['share'] } as const

const pptxI18n = createInstance()
void pptxI18n.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  resources: { en: { translation: translationsEn } },
  interpolation: { escapeValue: false },
})

const SPINNER = (
  <div className="flex items-center justify-center py-12 text-muted-foreground">
    <Loader2 className="w-5 h-5 animate-spin" />
  </div>
)

function isEncryptedOle(data: Uint8Array): boolean {
  return data.length > 8 && data[0] === 0xd0 && data[1] === 0xcf && data[2] === 0x11 && data[3] === 0xe0
}

interface PowerPointViewerHandle {
  getContent: () => Promise<Uint8Array>
  goTo?: (slideIndex: number) => void
  setActiveSlideIndex?: (index: number) => void
}

export default function PptxViewer({ data, fileName, editing, savePath, onFail, titleBarSlot }: { data: ArrayBuffer; fileName?: string; editing: boolean; savePath?: string; onFail: () => void; titleBarSlot?: ReactNode }) {
  // lib는 768px 미만에서 썸네일 패널을 숨기고 모바일 바/시트로 바꾼다.
  // 보기 모드에서도 좁은 화면에선 모바일 바를 켜야 슬라이드 시트에 닿는다.
  // (데스크톱은 editing 그대로라 변화 없음)
  const narrowViewport = useMobile()
  const appTheme = useTheme()
  const viewerTheme = useMemo(() => ({ colors: pptxThemeColors(appTheme === 'dark') }), [appTheme])
  const baseContent = useMemo(() => new Uint8Array(data.slice(0)), [data])
  const [savedBytes, setSavedBytes] = useState<Uint8Array | null>(null)
  const content = savedBytes ?? baseContent
  const [unlocked, setUnlocked] = useState<Uint8Array | null>(null)
  const viewerRef = useRef<PowerPointViewerHandle | null>(null)
  const setViewerRef = useCallback(
    (h: PowerPointViewerHandle | null) => {
      viewerRef.current = h
      // Y2: 새 viewer가 마운트되면 parse 전 lib이 0을 내보내므로 게이트를 잠근다.
      // lib의 onSlideCountChange(count > 0)로 다시 arm한다.
      if (h) {
        slideGateRef.current?.disarm()
        armedAtRef.current = performance.now()
      }
    },
    [],
  )
  const [saving, setSaving] = useState(false)
  // lib에서 코멘트 추가 등 모델이 바뀌면 우리 목록도 다시 읽는다 (저장 전에도 보인다).
  const refreshComments = useCallback(async () => {
    const h = viewerRef.current
    if (!h) return
    try {
      const bytes = await h.getContent()
      const cs = await loadPptxComments(new Uint8Array(bytes))
      setComments(cs)
    } catch {
      /* 무시 */
    }
  }, [])
  // S5: 편집 중 getContent() 직렬화는 코멘트 패널이 열려 있을 때만, 2초 debounce로.
  // collab owner는 write-back 스냅샷을 재사용한다.
  // solo 편집은 자동 저장한다 (웹이므로 모든 변경은 저장된다 — 조용히).
  const commentRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onViewerContentChange = useCallback(() => {
    if (commentRefreshTimer.current) clearTimeout(commentRefreshTimer.current)
    commentRefreshTimer.current = setTimeout(() => {
      if (!showCommentsRef.current) return
      const snap = latestSavedRef.current
      const c = collabRef.current
      if (c && snap) {
        void loadPptxComments(snap).then((cs) => setComments(cs)).catch(() => {})
        return
      }
      void refreshComments()
    }, 2000)
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current)
    autoSaveTimer.current = setTimeout(() => {
      const c = collabRef.current
      // collab 저장은 owner write-back이 전담한다. solo만 여기서 자동 저장한다.
      if (c || !editingRef.current) return
      const h = viewerRef.current
      if (!h) return
      void h
        .getContent()
        .then((b) => persistBytesRef.current(new Uint8Array(b), { quiet: true, auto: true }))
        .catch(() => {})
    }, 2500)
  }, [refreshComments])
  const [comments, setComments] = useState<PptxComment[]>([])
  const [showComments, setShowComments] = useState(false)
  const showCommentsRef = useRef(false)
  showCommentsRef.current = showComments
  const [slideIdx, setSlideIdx] = useState(0)
  // Q1: 방 해체(4001) 후 파일 재로드로 새 세션을 만들도록 키를 bump한다.
  const [renameSessionKey, setRenameSessionKey] = useState(0)
  // Q2: 렌더 시점 ref 불일치 방지를 위해 배너 정보를 state로 관리한다.
  const [imageLoss, setImageLoss] = useState<ImageLossDetail | null>(null)
  // V3: reset 확인 대기 중인 참가자 수 (0이면 확인창 없음).
  const [resetConfirmCount, setResetConfirmCount] = useState<number | null>(null)
  const [curSlide, setCurSlideRaw] = useState(0)
  // E20s: 화면 슬라이드 이력을 1-based로 기록해 "슬라이드 1"을 거쳤는지 판정한다.
  const curSlideHistoryRef = useRef<number[]>([])
  const setCurSlide = useCallback((n: number) => {
    const h = curSlideHistoryRef.current
    h.push(n + 1)
    if (h.length > 200) h.shift()
    setCurSlideRaw(n)
  }, [])
  // ref는 게이트(applyLocal)가 **먼저** 쓰고, 그 다음 state가 따라온다.
  // 136행의 렌더 후 동기화는 "state에서 오는 다른 경로"(팔로우·썸네일 클릭 등)의
  // 유일한 반영 지점이라 유지한다. 게이트가 ref를 직접 쓰는 것과 충돌하지 않는다.
  const curSlideRef = useRef(0)
  curSlideRef.current = curSlide
  // R4: sync 후 슬라이드 게시를 1회만 시도하기 위한 플래그 (세션마다 초기화).
  const slidePublishedRef = useRef(false)
  const [reloadKey, setReloadKey] = useState(0)
  // 신원 단일 통로: collab-user (presence·코멘트 공통).
  const [collabUser, saveCollabUser] = useCollabUser()
  const collabUserRef = useRef(collabUser)
  collabUserRef.current = collabUser
  const [author, setAuthor] = useState(() => {
    try {
      return localStorage.getItem('ppt-comment-author') ?? ''
    } catch {
      return ''
    }
  })
  // 코멘트 작성자 기본값: collab-user 이름을 처음 한 번만 가져온다.
  const authorOrUser = author.trim() || collabUser?.name || ''
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState(false)
  // 공동편집 (파일 열림부터 세션 참가 — 보기 모드는 view로, AI 차단을 걸지 않는다).
  const [collab, setCollab] = useState<{
    session: YCollabSession
    roomId: string
    epoch: string
    role: 'owner' | 'collaborator' | 'viewer'
    intent: 'create' | 'join'
    userId: string
  } | null>(null)
  // 서버 meta(type 100)의 owner (렌더 판정용). ownerIdRef는 콜백용 미러.
  const [metaOwner, setMetaOwner] = useState<number | null>(null)
  const [metaTick, setMetaTick] = useState(0)
  // P0-3: 참가자는 usePeers(로컬 awareness)가 전담한다. lock poll은 AI/외부변경용.
  // 신원 모달 없음 — 없으면 서버 발급 기본 이름으로 자동 참가한다.
  // E10: AI-blocked 칩 (서버 aiBlockedAt 래치 + 30초 클라이언트 만료).
  const [aiBlocked, setAiBlocked] = useState(false)
  const aiBlockRef = useRef<number | null>(null)
  const aiShownAtRef = useRef(0)
  // owner 대기 (2.4 교착 대비): 10초 초과 시 재시도 버튼.
  const [ownerWait, setOwnerWait] = useState(false)
  const [collabNotice, setCollabNotice] = useState<string | null>(null)
  const [mineFile, setMineFile] = useState<{ url: string; name: string } | null>(null)
  const [connBadge, setConnBadge] = useState<{ status: string; synced: boolean }>({ status: 'connecting', synced: false })
  const baseHashRef = useRef<string | null>(null)
  /**
   * M18: 4001 리셋이 진행 중인지. 리셋으로 언마운트될 때는 예약된 write-back 을 실행하지 않는다
   * (버린 방의 내용이 새 세션으로 저장되면 리셋이 무효가 된다).
   */
  const resetInFlightRef = useRef(false)
  /**
   * M11: 뷰어 리마운트가 발생한 뒤, 성공 저장이 아직 없는 상태.
   *
   * 리마운트(편집 모드 종료 등)는 뷰어를 **파일 기준**으로 다시 만들기 때문에,
   * 리마운트 직후의 자동 저장은 "직전 저장 이전 내용"을 디스크에 덮어쓸 수 있다
   * (E2 실패: 편집 저장 성공 → 리마운트 → 구 내용으로 덮어쓰기 = 조용한 유실).
   * 그래서 리마운트 후 첫 자동 저장은 막고, 사용자에게 알린다.
   */
  const remountedSinceSaveRef = useRef(false)
  /** M11: owner 인데 저장 요청이 3초 이상 없으면 탐지용 플래그. */
  const writebackStalledRef = useRef(false)
  const collabRef = useRef<typeof collab>(null)
  collabRef.current = collab
  // M31 1-a: 언마운트 때 setCollab(null) 로 화면 상태만 비워도, write-back 판정에 쓰는
  // 세션 정보(세션/roomId/epoch)는 남겨 둔다. 유예(3초) 안에 도착하는 flush 를 받쳐야 한다.
  const lastCollabRef = useRef<typeof collab>(null)
  if (collab) lastCollabRef.current = collab
  // M31 1-b: 마지막으로 **소유자였던** 세션. 언마운트(유예) 중에는 meta 갱신이 끊겨
  // isOwnerNow 가 false 가 될 수 있다 → 최종 판단은 서버 checkSave(409)에 맡긴다.
  const lastOwnerRef = useRef<typeof collab>(null)
  // M32 P0-2: 언마운트 중에만 스냅샷(owner/세션)을 신뢰한다. 마운트된 채 owner 를 잃으면
  // 저장 시도 자체를 하지 않는다(409 반복 = 배너 반복 방지).
  const unmountingRef = useRef(false)
  // M32 P0-2: 파일이 바뀌면 옛 세션 스냅샷을 버린다(옛 파일 바이트가 새 경로로 나가지 않게).
  useEffect(() => {
    lastCollabRef.current = null
    lastOwnerRef.current = null
    unmountingRef.current = false
  }, [savePath])
  const editingRef = useRef(editing)
  editingRef.current = editing
  // 세션 awareness mode의 진실 통로. role은 reconcile이 바꿀 수 있어서
  // 토글 가드로 쓰면 poll이 먼저 뒤집는 레이스에 setMode가 스킵된다.
  const sessionModeRef = useRef<'view' | 'edit'>('view')
  const toastedStatus = useRef<string | null>(null)
  // E2E 디버그 훅 (?collabDebug=1일 때만 window.__collabDebug 유지).
  const collabDebug = useMemo(() => {
    try {
      return new URLSearchParams(window.location.search).get('collabDebug') === '1'
    } catch {
      return false
    }
  }, [])
  const ownerIdRef = useRef<number | null>(null)
  const lastSaveRef = useRef<{ at: number; status: number } | null>(null)
  // M7 측정(S0): ?collab=0 이면 공동편집 세션 자체를 만들지 않는다. 기본은 on.
  // S0(뷰어 자체)과 S1(공동편집 경로)을 갈라서 재는 조건.
  const collabDisabled = useMemo(() => {
    try {
      return new URLSearchParams(window.location.search).get('collab') === '0'
    } catch {
      return false
    }
  }, [])
  const saveCountRef = useRef(0)
  const save409Ref = useRef(0)
  // M7 측정: 이 컴포넌트의 리렌더 횟수. 어떤 상태가 리렌더를 유발하는지
  // 특정하기 위한 계측이다(측정 후 제거 예정).
  const renderCountRef = useRef(0)
  renderCountRef.current += 1
  const updateDebug = useCallback(() => {
    if (!collabDebug) return
    try {
      const c = collabRef.current
      const w = window as unknown as { __collabDebug?: Record<string, unknown> }
      let slideCountY = 0
      try {
        slideCountY = c ? c.session.doc.getArray('pptx:slides').length : 0
      } catch {
        slideCountY = 0
      }
    w.__collabDebug = {
      mountCount: (w.__collabDebug?.mountCount as number | undefined) ?? 0,
      // M11: 진단 타임라인(최대 300개).
      timeline: tlDump(),
        curSlide,
        curSlideHistory: [...curSlideHistoryRef.current],
        // Z3: 상대 슬라이드 이력(1-based, -1 = 값 없음)과 arm 소요 시간.
        peerSlideHistory: peerSlideHistoryRef.current,
        armDelayMs: armDelayRef.current,
        role: c?.role ?? null,
        synced: c?.session.synced ?? false,
        ownerClientId: ownerIdRef.current,
        clientId: c?.session.clientId ?? 0,
        lastSave: lastSaveRef.current,
        saveCount: saveCountRef.current,
        save409Count: save409Ref.current,
        slideCountY,
        localMode: (c?.session.awareness.getLocalState() as { app?: { mode?: string } } | null)?.app?.mode ?? null,
        imageSync: c ? countPptxDocImages(c.session.doc as unknown as Parameters<typeof countPptxDocImages>[0]) : null,
        // 2-2: 탭당 세션 수 (E17: 1이어야 한다).
        sessionCount: collabSessionCount(),
        // M7 측정(S0): ?collab=0 이면 세션이 없어야 한다.
        collabDisabled,
        // M7 측정: PptxViewer 리렌더 횟수.
        renderCount: renderCountRef.current,
        // M7 측정: Y.Doc 업데이트 횟수. 리렌더 유발 경로 판별용.
        docUpdates: c?.session.docUpdateStats.updates ?? 0,
        docWriters: c?.session.docUpdateStats.writers ?? 0,
        // M7 측정: awareness 송·수신 누적. S3(상대 마우스 이동)에서
        // tx가 늘어나지 않으면 커서가 wire에서 제거된 것이다.
        awarenessTx: c?.session.awarenessStats.tx ?? 0,
        awarenessRx: c?.session.awarenessStats.rx ?? 0,
      }
    } catch {
      // 무시
    }
  }, [collabDebug])
  const [online, setOnline] = useState(() => {
    try {
      return typeof navigator === 'undefined' ? true : navigator.onLine
    } catch {
      return true
    }
  })
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])

  // P0-2: role/intent 단일 판정 (서버 meta + 내 clientId + doc 상태).
  // session 응답의 host/guest는 resume/epoch에만 쓰고 판정에 쓰지 않는다.
  // handleWriteBack보다 앞에서 정의한다 (TDZ 방지).
  const isOwnerNow = useCallback((c: { session: YCollabSession } | null): boolean => {
    return !!c && ownerIdRef.current != null && ownerIdRef.current === c.session.clientId
  }, [])

  // B3: 'owner 미확정'과 '남이 owner'를 구분한다. 둘을 합치면 승계 직후의 저장이 오판된다.
  const ownerStateOf = useCallback((c: { session: YCollabSession } | null): OwnerState => {
    if (!c || ownerIdRef.current == null) return 'unknown'
    return ownerIdRef.current === c.session.clientId ? 'self' : 'other'
  }, [])

  // B3: 선출이 끝날 때까지 meta를 기다린다. ownerClientId는 onMeta로만 채워지고
  // (아래 onMeta 핸들러) 폴링 경로와 겹쳐 최대 5초 걸릴 수 있다.
  const waitOwnerId = useCallback(async (timeoutMs: number): Promise<boolean> => {
    if (ownerIdRef.current != null) return true
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
      if (ownerIdRef.current != null) return true
    }
    return false
  }, [])

  // B3: 위임 저장은 호출자가 고른 문구로 토스트를 한 번만 띄운다(수동 저장 1회 = 토스트 1개).
  const delegatedSaveRef = useRef(false)

  const reconcileCollab = useCallback(() => {
    const c = collabRef.current
    if (!c) return
    const editMode = editingRef.current
    const owner = isOwnerNow(c)
    const wantRole = !editMode ? 'viewer' : owner ? 'owner' : 'collaborator'
    let empty = true
    try {
      empty = c.session.doc.getArray('pptx:slides').length === 0
    } catch {
      empty = true
    }
    const wantIntent = editMode && owner && empty ? 'create' : 'join'
    if (c.role !== wantRole || c.intent !== wantIntent) {
      setCollab({ ...c, role: wantRole, intent: wantIntent })
    }
  }, [isOwnerNow])

  // 저장 일원화: collab 중이면 owner save API, 아니면 직접 저장.
  // 판정은 서버 lastHash 기준. 실패는 절대 조용히 넘기지 않는다
  // (quiet 자동 저장만 조용히 실패한다).
  // S3: content 고정 — 성공해도 setSavedBytes를 호출하지 않고 latestSavedRef에만
  // 둔다 (content 변경 → lib 리로드 → 캐럿 유실 방지). 세션 종료·파일 교체 때 반영.
  const latestSavedRef = useRef<Uint8Array | null>(null)
  const persistBytes = useCallback(async (bytes: Uint8Array, opts?: { quiet?: boolean; auto?: boolean; allowImageLoss?: boolean }): Promise<boolean> => {
    const quiet = opts?.quiet ?? false
    const auto = opts?.auto ?? false
    const c = collabRef.current
    if (c && savePath) {
      // 빈 바이트: adopt 경합·lib 준비 전(getContent가 아직 0바이트)일 때 발생한다.
      // 자동 경로는 조용히 스킵하고 500ms 뒤 1회 재시도한다 (배너 없음).
      // 사용자가 직접 누른 저장일 때만 배너를 띄운다.
      if (bytes.length === 0) {
        logClient(`empty_snapshot len=0 auto=${auto ? 1 : 0}`)
        tl('save.skip', { reason: 'empty_bytes', auto: !!auto, halted: writeBackHaltedRef.current })
        if (auto) {
          if (!emptyRetryRef.current) {
            emptyRetryRef.current = setTimeout(() => {
              emptyRetryRef.current = null
              // R5: 재시도 직전에 owner·sync 상태를 다시 확인한다 (다른 파일로 옮겼을 수 있다).
              const cur = collabRef.current
              if (!cur || !isOwnerNow(cur) || !cur.session.synced) return
              const h = viewerRef.current
              if (!h) return
              void h
                .getContent()
                .then((b) => {
                  if (new Uint8Array(b).length === 0) return
                  return persistBytesRef.current(new Uint8Array(b), { quiet: true, auto: true })
                })
                .catch(() => {})
            }, 500)
          }
          return false
        }
        setCollabNotice('Nothing to save yet — try again in a moment.')
        return false
      }
      // R1: 이미지 손실로 자동 저장이 중지된 세션은 요청 자체를 보내지 않는다 (2.5초 루프 방지).
      if (writeBackHaltedRef.current && auto) {
        logClient('write_back_halted_skip')
        tl('save.skip', { reason: 'halted', auto: true })
        return false
      }
      // M11: 리마운트 직후의 자동 저장은 **구(舊) 내용**일 수 있다.
      // (원인: 뷰어가 파일(캐시) 기준으로 다시 만들어짐 → 백엔드가 no-store 로 막아준다.)
      // 여기서는 저장을 막지 않고, 조용한 유실을 탐지할 수 있도록 상태만 기록한다.
      if (remountedSinceSaveRef.current && auto) {
        tl('save.after_remount', { halted: writeBackHaltedRef.current })
      }
      // B3: owner가 아닌 사람은 저장을 위임한다. 서버는 owner만 쓰기 때문에
      // (D05) 여기서 곧바로 API를 부르면 denied → 'Save rejected'로 번져
      // "Save failed — staying in edit mode"이 떴다.
      const intent = decideSaveIntent({ owner: ownerStateOf(c), synced: c.session.synced })
      if (intent.kind === 'await-meta' && intent.reason === 'owner-unknown') {
        await waitOwnerId(3000)
      }
      if (decideSaveIntent({ owner: ownerStateOf(c), synced: c.session.synced }).kind === 'delegated') {
        // latestSavedRef는 "디스크에 쓰인 바이트"이므로 건드리지 않는다.
        // 내가 쓴 게 아니라 owner가 쓴다. 여기서 갱신하면 세션 종료 때
        // setSavedBytes가 저장 안 된 바이트를 저장된 것으로 되돌린다.
        delegatedSaveRef.current = true
        if (!auto) setCollabNotice(null)
        return true
      }
      let res = await collabApi.save(c.roomId, c.session.clientId, bytes, baseHashRef.current, opts?.allowImageLoss ?? false)
    tl('save.response', { ok: res.ok, reason: res.ok ? 'ok' : res.reason, bytes: bytes.length })
      // B3: 내가 owner인데 denied면 meta가 늦은 것일 수 있다(선출 직후). 1회만 기다려 재시도한다.
      if (!res.ok && res.reason === 'denied' && !auto && ownerStateOf(c) === 'self') {
        await waitOwnerId(1000)
        if (ownerStateOf(c) === 'self') {
          res = await collabApi.save(c.roomId, c.session.clientId, bytes, baseHashRef.current, opts?.allowImageLoss ?? false)
        }
      }
      // E2E 디버그: 저장 결과 기록 (200/409 추적용).
      saveCountRef.current += 1
      if (res.ok) {
        lastSaveRef.current = { at: Date.now(), status: 200 }
      } else if (res.reason === 'conflict' || res.reason === 'denied' || res.reason === 'image_loss') {
        lastSaveRef.current = { at: Date.now(), status: 409 }
        save409Ref.current += 1
      } else {
        lastSaveRef.current = { at: Date.now(), status: 0 }
      }
      updateDebug()
      if (res.ok) {
        baseHashRef.current = res.newHash
        c.session.knownHash = res.newHash
        // S3: content 고정 — 세션 종료 때 한 번만 반영한다.
        latestSavedRef.current = new Uint8Array(bytes)
        // M11: 저장이 성공했으므로 "리마운트 후 미검증 상태"를 해제한다.
        remountedSinceSaveRef.current = false
        writebackStalledRef.current = false
        // 저장 성공 시 남은 배너를 지운다 (5번: 배너가 안 사라지는 문제).
        if (!auto) setCollabNotice(null)
        return true
      }
      if (res.reason === 'conflict') {
        setCollabNotice('외부에서 변경됨 — 다시 열기 (자동 병합 없음).')
      } else if (res.reason === 'image_loss') {
        // R1/R2: 자동 write-back을 중지하고(epoch당 1회), 다운로드 제안도 1회만.
        // 배너에서 "이미지 삭제 확정 저장"을 누르면 allowImageLoss로 다시 시도한다.
        logClient(`image_loss blocked media=${res.detail?.before.media ?? '?'}->${res.detail?.after.media ?? '?'}`)
if (!writeBackHaltedRef.current) {
          writeBackHaltedRef.current = true
          lossPendingRef.current = new Uint8Array(bytes)
          setImageLoss(res.detail ?? null)
          void offerMineDownloadRef.current?.()
        }
        const n = res.detail ? res.detail.before.media - res.detail.after.media : 0
        setCollabNotice(
          `이미지가 ${n > 0 ? `${n}개 줄어서 ` : ''}저장을 막았습니다 — 삭제가 맞으면 확인하고 저장하세요.`,
        )
      } else if (res.reason === 'not_seeded') {
        setCollabNotice('아직 동기화 전입니다. 잠시 후 다시 저장하세요.')
      } else if (!auto) {
        setCollabNotice(res.message ?? 'Save denied (not owner).')
      }
      if (!quiet) showToast.error(res.message ?? 'Save failed')
      return false
    }
    if (!savePath) return false
    try {
      await saveOfficeBytes(
        savePath,
        fileName ?? 'presentation.pptx',
        new Blob([bytes as unknown as BlobPart], {
          type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        }),
      )
    } catch (e) {
      if (!quiet) showToast.error(e instanceof Error ? e.message : '저장 실패')
      return false
    }
    latestSavedRef.current = new Uint8Array(bytes)
    return true
  }, [fileName, savePath, updateDebug, ownerStateOf, waitOwnerId])
  const persistBytesRef = useRef(persistBytes)
  persistBytesRef.current = persistBytes

  // owner write-back (lib이 변경 debounce 후 호출). 서버 owner일 때만 저장한다.
  // lib role과 서버 owner가 어긋나도 409가 나지 않게 meta 기준으로 걸러 낸다.
  // M28 1-1′: 세션/owner 확인은 **ref 로 읽는다**(첫 렌더 클로저 고착 방지, P0-3).
  const isOwnerNowRef = useRef(isOwnerNow)
  isOwnerNowRef.current = isOwnerNow
  const tlRef = useRef(tl)
  tlRef.current = tl
  const savePathRef = useRef(savePath)
  savePathRef.current = savePath
  // M28 1-1′: 저장 직렬화 모듈(in-flight 1개 + latest-wins, P0-1/P0-2/P0-3/P0-4 반영).
  const saveSerializerRef = useRef<SaveSerializer<Uint8Array> | null>(null)
  if (!saveSerializerRef.current) {
    saveSerializerRef.current = createSaveSerializer<Uint8Array>({
      save: async (bytes) => {
        // persistBytes 는 **boolean 반환형**(throw 하지 않음).
        //  M28: skip(빈 바이트/세션 없음) / denied(409) / network(상태 0) 를 구분한다.
        //  skip 은 재시도 금지(같은 바이트로 다시 보내도 결과가 같다).
        if (bytes.length === 0) return { skipped: 'empty_bytes' as const }
        if (!collabRef.current) return { skipped: 'nothing_to_save' as const }
        const beforeAt = lastSaveRef.current?.at
        const r = await persistBytesRef.current(bytes)
        if (r === true) return { ok: true as const }
        // M29 P0-1: 분류는 **이 호출의 응답** 기준이다(직전 저장 상태로 추측하지 않는다).
        //  응답이 갱신되지 않았으면 persistBytes 안쪽의 skip 이다(정상 종료 → 재시도 없음).
        const after = lastSaveRef.current
        if (!after || after.at === beforeAt) return { skipped: 'internal_skip' as const }
        if (after.status === 409) return { ok: false as const, reason: 'denied', retryable: false }
        if (after.status === 0) return { ok: false as const, reason: 'network', retryable: true }
        if (after.status >= 500) return { ok: false as const, reason: 'server', retryable: true }
        return { ok: false as const, reason: 'save_failed', retryable: false }
      },
      canSave: () => {
        const c = collabRef.current
        return !!c && isOwnerNowRef.current(c) && c.session.synced
      },
      getSession: () => {
        // M29 P0-3: epoch 는 **타입이 있는 필드**(PptxViewer.tsx:261 collab.epoch,
        // ycollab.ts:104 YCollabSessionResult.epoch / :117 YCollabMeta.epoch)에서 읽는다.
        // M33 A: 언마운트 후 collabRef 가 null 이어도 마지막 세션으로 판정한다.
        const c = collabRef.current ?? lastCollabRef.current
        return { path: savePathRef.current, epoch: c?.epoch, roomId: c?.roomId }
      },
      onEvent: (e) =>
        tlRef.current(e.evt, {
          ...(e as unknown as Record<string, unknown>),
          // M32 P0-1: 어느 클라이언트가 저장했는지 추적(서버 로그의 cid 와 대조).
          cid: collabRef.current?.session?.clientId ?? lastCollabRef.current?.session?.clientId,
        }),
      retry: { attempts: 2, delayMs: 500 },
    })
  }
  // M28 P1-6: 언마운트 시 재시도 타이머/잔여 요청 정리(D27/메모리 규칙).
  // M32 P0-2: 언마운트 표시 → 이때만 owner/세션 스냅샷을 신뢰한다.
  useEffect(
    () => () => {
      unmountingRef.current = true
      saveSerializerRef.current?.dispose()
    },
    [],
  )
  // M34 가드는 v0.13 로 되돌렸다(비소유자/보기 모드에서 닫기 차단 회귀).
  // 닫기 경로(E2f-strict)가 실제로 실패할 때 endEditing 경로로 다시 만든다.

  const handleWriteBack = useCallback(async (bytes: Uint8Array) => {
    // M31 1-a: 언마운트 후에는 화면 상태(collab)가 null 이지만 세션은 유예 동안 살아 있다.
    // collabRef 만 보면 hasSession=false 가 되어 flush 가 버려진다 → 마지막 세션을 fallback 으로 쓴다.
    const c = collabRef.current ?? lastCollabRef.current
    // M11 계측: write-back 경로 진입/건너뜀 사유.
    tl('writeback.enter', {
      hasSession: !!c,
      isOwner: c ? isOwnerNow(c) : false,
      synced: c ? c.session.synced : false,
      bytes: bytes.length,
      halted: writeBackHaltedRef.current,
    })
    if (!c) {
      tl('writeback.skip', { reason: 'no_session' })
      return
    }
    // M31 1-b: owner 여부는 **요청 시점 스냅샷**으로 고정한다(루프에서 "세션이 바뀌었는가"만 본다).
    // 서버 checkSave 가 최종 판정(409 not_owner)하므로, 클라이언트 판정이 false 여도 저장은 시도한다.
    if (isOwnerNow(c)) lastOwnerRef.current = c
    else if (!unmountingRef.current) lastOwnerRef.current = null
    // M32 P0-2: owner 판정은 **마지막 소유자 세션 스냅샷**으로 고정한다.
    // 언마운트 flush 는 cleanup 보다 먼저 도착할 수 있어(cleanup 후 ref 로는 판정 불가),
    // 이때는 meta 가 갱신되지 않아 isOwnerNow 가 false 다 → 스냅샷으로 저장 시도를 허용한다.
    // 마운트 중 owner 상실은 위에서 스냅샷을 비우므로 재시도가 일어나지 않는다.
    // 최종 판단은 서버 checkSave(409)에 맡긴다.
    // M33 B: 객체 동일성 대신 키(roomId/epoch)로 비교한다.
    // setCollab({...}) 로 meta/role 이 갱신되면 객체가 바뀌어도 "같은 소유자 세션"으로 남는다.
    const ownerBySnapshot =
      lastOwnerRef.current !== null &&
      lastOwnerRef.current.roomId === c.roomId &&
      lastOwnerRef.current.epoch === c.epoch
    if (!isOwnerNow(c) && !ownerBySnapshot) {
      tl('writeback.skip', { reason: 'not_owner' })
      return
    }
    if (!c.session.synced) {
      tl('writeback.skip', { reason: 'not_synced' })
      return
    }
    let slides = 0
    try {
      slides = c.session.doc.getArray('pptx:slides').length
    } catch {
      slides = 0
    }
    if (slides === 0) {
      tl('writeback.skip', { reason: 'empty_doc' })
      return
    }
    // M11: owner 인데 저장 요청이 3초 이상 없으면 탐지한다(조용한 유실 방지).
    if (!writebackStalledRef.current) {
      writebackStalledRef.current = true
      window.setTimeout(() => {
        if (!writebackStalledRef.current) return
        console.warn('[collab] writeback_stalled: owner 인데 3초 이상 저장 요청이 없음', {
          path: savePath,
        })
        tl('writeback.stalled', { reason: 'no_save_request' })
      }, 3000)
    }
    // M26 3-1 / M27 1-1: 저장은 **in-flight 1개 + latest-wins** (순수 모듈 saveSerializer).
    // lib 이 flush(즉시)와 debounce(2.5초) 두 경로로 저장 요청을 보낼 수 있고, 각자 serialize
    // 한 뒤 호출한다. 동시에 나가면 "먼저 시작한 저장이 나중에 끝나" 디스크 최종본이 옛 내용이 되는
    // 역전이 생긴다(큰 덱은 serialize 에 수백 ms~수 초 걸린다).
    // 진행 중 저장이 있으면 **최신 바이트만** 보관했다가 끝난 뒤 1회 더 저장한다(중간 요청은 합쳐짐).
    // owner/synced 는 **저장 직전에 다시** 확인한다(P0-3: 대기열의 저장이 owner 교대 뒤 나가면
    // 409 를 받고 조용히 유실된다. 새 owner 가 같은 Y.Doc 상태를 저장하므로 유실이 아니다).
    // M28 P0-2: 요청 시점의 세션(경로/epoch)을 함께 묶어 둔다. 저장 직전에 현재 값과 비교해
    // 다르면(파일 변경/4001 리셋) 그 바이트는 내보내지 않는다(D41: 세션 교체 시 flush 금지).
    // M33 A: 언마운트 후에도 collabRef 가 null 이어도 마지막 세션으로 epoch/roomId 를 붙인다.
    // (epoch 이 없으면 serializer 의 fail-closed 규칙에 걸려 저장이 조용히 버려진다.)
    const c0 = collabRef.current ?? lastCollabRef.current
    return saveSerializerRef.current!.request(bytes, {
      session: { path: savePath, epoch: c0?.epoch, roomId: c0?.roomId },
    })
  }, [persistBytes, isOwnerNow, savePath])
  // 내 사본 다운로드 (409 터미널 탈출용).
  const offerMineDownload = useCallback(async () => {
    try {
      const h = viewerRef.current
      if (!h) return
      const bytes = new Uint8Array(await h.getContent())
      const blob = new Blob([bytes as unknown as BlobPart], {
        type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      })
      const url = URL.createObjectURL(blob)
      const base = (fileName ?? 'presentation.pptx').replace(/\.pptx$/i, '')
      setMineFile({ url, name: `${base}.mine.pptx` })
    } catch {
      // 무시
    }
  }, [fileName])
  const offerMineDownloadRef = useRef<(() => Promise<void>) | null>(null)
  offerMineDownloadRef.current = offerMineDownload
  const emptyRetryRef = useRef<ReturnType<typeof setTimeout> | null>(null)
/**
 * M16: **커밋 반영 대기는 삭제.** 앵커(바이트 비교)는 원리상 틀렸다 —
 * 앵커는 "마지막으로 실행된 write-back" 이므로 Escape 시점의 커밋 write-back(아직 예약 상태)과
 * 다르다. 바이트가 같아지는 순간은 오히려 구 내용을 "반영 완료"로 오판한다.
 * lib 이 리마운트/role 변경 cleanup 에서 예약을 cancel() 하는 문제는
 * **패치로 해결**한다(ooxml-ui / pptx-react-viewer: cancel → flush).
 * ⇒ 앱은 "lib 이 넘긴 저장의 응답"을 await 하면 된다.
 */
  // R5: 빈 스냅샷 재시도 타이머는 파일 전환/언마운트 때 반드시 해제한다.
  // (해제 안 하면 다른 파일로 옮긴 뒤 그 파일 내용을 저장할 수 있다.)
  useEffect(() => {
    return () => {
      if (emptyRetryRef.current) {
        clearTimeout(emptyRetryRef.current)
        emptyRetryRef.current = null
      }
    }
  }, [savePath])
  // R1: 이미지 손실로 자동 저장이 중지됐는지 (epoch당 1회, 세션 변경 시 초기화).
  const writeBackHaltedRef = useRef(false)
  const lossPendingRef = useRef<Uint8Array | null>(null)
  /** R2: 배너에서 "이미지 삭제가 맞다"고 확인하면 allowImageLoss로 1회 저장한다. */
  const confirmImageLossSave = useCallback(async () => {
    const pending = lossPendingRef.current
    if (!pending) return
    lossPendingRef.current = null
    writeBackHaltedRef.current = false
const ok = await persistBytesRef.current(pending, { quiet: true, auto: false, allowImageLoss: true })
    if (ok) setImageLoss(null)
    logClient(`image_loss_confirmed ok=${ok ? 1 : 0}`)
    if (ok) setCollabNotice(null)
  }, [])

/** Q2: owner만 호출. 서버가 WS conn 기준으로 권한을 확인하고 전원을 해체시킨다. */
  const requestRoomReset = useCallback(() => {
    const c = collabRef.current
    if (!c) return
    // V3: 다른 참가자가 있으면 확인창을 먼저 띄운다 (저장 안 된 변경이 사라짐).
    const others = peersRef.current.filter((p) => !p.isSelf)
    if (others.length > 0) {
      setResetConfirmCount(others.length)
      return
    }
    doResetRoom()
  }, [])

  /** 확인 후 실제 요청. */
  const doResetRoom = useCallback(() => {
    const c = collabRef.current
    if (!c) return
    setResetConfirmCount(null)
    logClient('reset_request_sent')
    c.session.requestReset()
    showToast.info('owner가 파일 기준으로 다시 열었습니다')
  }, [])

  /** guest용 안내 — 버튼은 owner에게만 보인다. */
  const isResetOwner = isOwnerNow(collabRef.current)

  /** E2E/디버그용 클라이언트 로그 (?collabDebug=1에서만 수집, 상한 200). */
  const clientLogs = useRef<string[]>([])
  const logClient = (msg: string): void => {
    if (!collabDebug) return
    try {
      clientLogs.current.push(`${Date.now() % 1000000} ${msg}`)
      if (clientLogs.current.length > 200) clientLogs.current.splice(0, clientLogs.current.length - 200)
      const w = window as unknown as { __collabDebug?: Record<string, unknown> }
      w.__collabDebug = { ...(w.__collabDebug ?? {}), clientLogs: [...clientLogs.current] }
    } catch {
      // 무시
    }
  }

  // 저장 리스너: persistBytes보다 뒤에 있어야 한다 (deps 배열이 렌더 시점에
  // 평가되므로 앞에서 참조하면 TDZ가 난다).
  useEffect(() => {
    const onSave = () => {
      if (saving) return
      const h = viewerRef.current
      if (!h || !savePath) return
      delegatedSaveRef.current = false
      setSaving(true)
      void (async () => {
        // M16: 수동 저장 경로는 대기 없이 getContent 1회로 직렬화한다.
        const bytes = await h.getContent()
        // 수동 저장 경로라 배너/토스트를 막지 않는다 (R3).
        const fresh = new Uint8Array(bytes)
        const ok = await persistBytes(fresh, { quiet: true, auto: false })
        if (!ok) throw new Error('Save rejected')
        const cs = await loadPptxComments(fresh)
        setComments(cs)
      })()
        .then(() => {
          // B3: owner가 아닌 사람의 저장은 위임이다. "저장했습니다"라고 하면
          // 디스크에 쓴 사람이 나인 것처럼 보인다. 토스트는 수동 저장 1회 = 1개.
          const delegated = delegatedSaveRef.current
          delegatedSaveRef.current = false
          showToast.success(delegated ? '자동 저장됩니다 — owner가 디스크에 씁니다' : '저장했습니다')
          // B1(b): 파일 식별자를 함께 보낸다. 없으면 다른 뷰어의 저장 완료에
          // 이 문서의 편집이 종료된다 (DocumentPreview.tsx:452).
          window.dispatchEvent(
            new CustomEvent('officeSaveDone', { detail: { ok: true, path: savePath } }),
          )
        })
        .catch((e) => {
          delegatedSaveRef.current = false
          showToast.error(e instanceof Error ? e.message : '저장 실패')
          window.dispatchEvent(
            new CustomEvent('officeSaveDone', { detail: { ok: false, path: savePath } }),
          )
        })
        .finally(() => setSaving(false))
    }
    window.addEventListener('officeSaveRequest', onSave)
    return () => window.removeEventListener('officeSaveRequest', onSave)
  }, [savePath, fileName, saving, persistBytes])

  // 편집 진입/종료에 맞춰 세션 모드 전환 (세션·doc 유지, 리마운트 없음).
  // role은 reconcile이 meta 기준으로 확정한다 (prop 런타임 변경 지원 — lib 확인됨).
  // 토글 effect와 세션 생성 완료 시점이 함께 호출한다: 비동기 생성과 토글이
  // 서로의 윈도우를 놓쳐도 modeRef 가드가 아니라 최신 editing으로 수렴한다.
const syncSessionMode = useCallback(() => {
    const c = collabRef.current
    if (!c || !savePath) return
    // E20/F3: edit↔view 전환은 viewer를 리마운트시키므로, 리스너/presence 정리 뒤
    // app 필드가 살아 있는지 확인하고 없으면 즉시 다시 게시한다.
    c.session.republishApp()
    if (editingRef.current && sessionModeRef.current !== 'edit') {
      c.session.setMode('edit')
      sessionModeRef.current = 'edit'
      reconcileCollab()
    } else if (!editingRef.current && sessionModeRef.current !== 'view') {
      const target = c
      void (async () => {
        try {
          if (isOwnerNow(collabRef.current) && target.session.synced) {
            const h = viewerRef.current
            if (h) await persistBytes(new Uint8Array(await h.getContent()), { quiet: true, auto: true })
          }
        } catch {
          // 무시
        } finally {
          if (collabRef.current !== target) return
          target.session.setMode('view')
          sessionModeRef.current = 'view'
          reconcileCollab()
        }
      })()
    }
  }, [savePath, persistBytes, reconcileCollab, isOwnerNow])

  // 세션 생명주기: 파일 열림 ~ 닫힘. 보기 모드도 view로 참가한다 (AI 차단 없음).
  // 편집 진입/종료는 아래 모드 전환 effect가 처리한다. 실패하면 solo로 폴백.
  // 신원이 없으면 서버 발급 기본 이름으로 즉시 만들어서 참가한다 (모달 없음).
  useEffect(() => {
    if (!savePath) return
    // M7 측정(S0): 공동편집을 끄면 세션·WS·awareness가 아예 없다.
    if (collabDisabled) return
    let dead = false
    // M3/N1: release는 토큰(lease) 기준이다. collabRef를 경로로 삼지 않는다.
    // collabRef.current는 렌더 시점(L194)에 채워지므로 acquire 직후 언마운트하면 null이고,
    // 이전처럼 경로로 release하면 **acquire하지 않은 뷰어가 남의 refs를 깎을 수 있다.**
    let lease: ReturnType<typeof acquireCollabSession> | null = null
    const user = collabUserRef.current
    if (!user) {
      // 자동 참여: 기본 이름 발급 → 저장 → effect 재실행에서 참가한다.
      void (async () => {
        try {
          const name = await collabApi.suggestName()
          if (dead) return
          let exclude: string[] = []
          try {
            const lock = await collabApi.lock(savePath)
            exclude = (lock.participants ?? []).map((p) => p.color.toLowerCase())
          } catch {
            // 조회 실패는 무시 (fail-open).
          }
          if (dead) return
          const pool = COLLAB_PALETTE.filter((c) => !exclude.includes(c.toLowerCase()))
          const list = pool.length > 0 ? pool : [...COLLAB_PALETTE]
          const color = list[Math.floor(Math.random() * list.length)]!
          saveCollabUser({
            id: `u-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
            name,
            color,
          })
        } catch {
          // 발급 실패는 로컬 폴백으로 참가한다.
          if (!dead) {
            saveCollabUser({
              id: `u-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
              name: `user${Math.floor(Math.random() * 900 + 100)}`,
              color: COLLAB_PALETTE[Math.floor(Math.random() * COLLAB_PALETTE.length)]!,
            })
          }
        }
      })()
      return
    }
    // 클릭이 session POST를 가로지를 수 있으므로, 모드 판정은 await 뒤에서
    // fresh하게 읽는다 (stale 캡처 금지).
    void (async () => {
      try {
        const info = await collabApi.session(savePath)
        if (dead) return
        const userNow = collabUserRef.current
        if (!userNow) return
        const freshEditing = editingRef.current
        sessionModeRef.current = freshEditing ? 'edit' : 'view'
        // 2-2: 탭당 파일당 세션 1개 (인라인/전체화면 공유).
      const acquired = acquireCollabSession(
        savePath,
        () =>
          new YCollabSession(
            `${collabServerUrl()}/${info.roomId}`,
            { name: userNow.name, color: userNow.color },
            { mode: freshEditing ? 'edit' : 'view', userId: userNow.id, device: narrowViewport ? 'mobile' : 'desktop' },
          ),
        (created) => {
          created.knownHash = info.lastHash
          // M18: 새 세션이므로 리셋 플래그를 해제한다(기본값 = 언마운트 시 flush 허용).
          resetInFlightRef.current = false
          wireSessionRecovery(created)
          created.connect()
        },
        )
        // M3/N1: cleanup이 쓸 토큰을 effect 지역에 보관한다.
        lease = acquired
        const { session, reused } = acquired
        // 공유 세션이면 신원/모드만 갱신한다 (연결·리스너 중복 없음).
        if (reused) {
          session.setUser({ name: userNow.name, color: userNow.color })
          session.setMode(freshEditing ? 'edit' : 'view')
        }
        baseHashRef.current = info.lastHash
        setCollabNotice(null)
        setMineFile(null)
        toastedStatus.current = null
        // 새 세션(epoch)이면 이미지 손실 정지/대기 바이트를 초기화한다.
writeBackHaltedRef.current = false
        lossPendingRef.current = null
        slidePublishedRef.current = false
        // W1-b: 세션이 바뀌면 예약된 0 게시를 버린다(옛 세션 좌표를 새 세션에 싣지 않는다).
        slideGateRef.current?.dispose()
        setImageLoss(null)
        setCollab({
          session,
          roomId: info.roomId,
          epoch: info.epoch,
          // 가판정 (join이 안전 기본값). meta+sync가 오면 reconcile이 확정한다.
          role: freshEditing ? 'collaborator' : 'viewer',
          intent: 'join',
          userId: userNow.id,
        })
        setMetaTick(0)
        setMetaOwner(null)
        updateDebug()
        // 생성 시점에 이미 편집 중이면 모드를 확정한다 (토글이 윈도우를 놓친 경우).
        syncSessionMode()
      } catch {
        if (!dead) setCollab(null)
      }
    })()
    return () => {
      dead = true
      const c = collabRef.current
      // M3/N1: 해제는 **내 토큰**으로만 한다.
      // - acquire를 마치지 못한 마운트는 lease가 null이라 아무것도 하지 않는다.
      // - drop 후 같은 경로에 새 세션이 있어도 내 lease는 옛 entry만 잡고 있으므로 무효가 된다.
      // 이전처럼 savePath로 release하면 acquire하지 않은 뷰어가 남의 refs를 깎는다.
      if (!lease) return
      const held = lease
      if (!c) {
        held.release()
        return
      }
      // 나갈 때: owner면 마지막 flush 후 세션 파괴 (서버가 남은 쪽으로 자동 승계).
      // ref는 체인이 끝날 때까지 유지한다 (persistBytes가 ref를 읽기 때문).
      void (async () => {
        try {
          if (isOwnerNow(c) && c.session.synced) {
            const h = viewerRef.current
            if (h) await persistBytes(new Uint8Array(await h.getContent()), { quiet: true, auto: true })
          }
        } catch {
          // 무시
        } finally {
          // 마지막 참조가 아니면 세션은 살려두고 이 뷰어의 상태만 정리한다 (2-2).
          held.release()
          aiBlockRef.current = null
          setAiBlocked(false)
          ownerIdRef.current = null
          setMetaOwner(null)
          setMetaTick(0)
          setOwnerWait(false)
          // S3: 세션 종료 때 한 번만 content에 반영한다.
          if (latestSavedRef.current) {
            setSavedBytes(latestSavedRef.current)
            latestSavedRef.current = null
          }
          updateDebug()
          if (collabRef.current === c) {
            collabRef.current = null
            setCollab(null)
            baseHashRef.current = null
          }
        }
      })()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savePath, collabUser, renameSessionKey, collabDisabled])

  // 이름 변경 (우측 내 칩에서 편집). 저장하면 전 viewer에 전파되고,
  // lib presence 라벨도 바꾸기 위해 viewer를 리마운트한다 (같은 doc 유지).
const [renaming, setRenaming] = useState(false)
  const [renameInput, setRenameInput] = useState('')
  const submitRename = useCallback(() => {
    const name = renameInput.trim()
    if (!name) {
      setRenaming(false)
      return
    }
    const prev = collabUserRef.current
    if (prev) {
      saveCollabUser({ ...prev, name })
      const c = collabRef.current
      if (c) {
        try {
          c.session.setUser({ name, color: prev.color })
        } catch {
          // 무시
        }
      }
    }
    setRenaming(false)
    setReloadKey((v) => v + 1)
  }, [renameInput, saveCollabUser])

  // E10: 서버 aiBlockedAt이 새로 찍히면 칩을 래치한다. 같은 값이면 유지.
  // 표시는 래치 시점 기준 30초 (page.clock으로 앞당길 수 있다).
  const trackAiBlocked = useCallback((blockedAt: number | null) => {
    if (blockedAt != null && blockedAt !== aiBlockRef.current) {
      aiBlockRef.current = blockedAt
      aiShownAtRef.current = Date.now()
    }
    setAiBlocked(
      aiBlockRef.current != null && Date.now() - aiShownAtRef.current < 30_000,
    )
  }, [])

  // P0-2 파생값 (렌더·타이머 공용). ref/live-doc 읽기이며,
  // 구독·poll·meta가 렌더를 일으킬 때마다 재계산된다.
  const amOwnerRender = !!collab && metaOwner != null && metaOwner === collab.session.clientId
  const docEmptyRender = (() => {
    if (!collab) return true
    try {
      return collab.session.doc.getArray('pptx:slides').length === 0
    } catch {
      return true
    }
  })()
  const waitingForOwner =
    !!collab && editing && collab.session.synced && metaTick > 0 && !amOwnerRender && docEmptyRender
  const needCreateIntent =
    !!collab && editing && amOwnerRender && docEmptyRender && collab.intent !== 'create'

  // 편집 진입/종료에 맞춰 세션 모드 전환 (세션·doc 유지, 리마운트 없음).
  // role은 reconcile이 meta 기준으로 확정한다 (prop 런타임 변경 지원 — lib 확인됨).
  // 가드는 role이 아니라 sessionModeRef로 건다 (poll-reconcile과의 레이스 방지).
  useEffect(() => {
    syncSessionMode()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, savePath, syncSessionMode])

  // 2.4: owner인데 join으로 마운트됐으면 3초 뒤 create로 한 번만 전환한다.
  useEffect(() => {
    if (!needCreateIntent) return
    const id = setTimeout(() => {
      const cur = collabRef.current
      if (!cur || !isOwnerNow(cur) || cur.intent === 'create') return
      let stillEmpty = true
      try {
        stillEmpty = cur.session.doc.getArray('pptx:slides').length === 0
      } catch {
        stillEmpty = true
      }
      if (stillEmpty && collabRef.current === cur) {
        setCollab({ ...cur, intent: 'create' })
      }
    }, 3000)
    return () => clearTimeout(id)
  }, [needCreateIntent, isOwnerNow])

  // 2.4: owner도 방도 비어 있는데 10초가 넘으면 재시도 버튼을 보여준다.
  useEffect(() => {
    if (!waitingForOwner) {
      setOwnerWait(false)
      return
    }
    const id = setTimeout(() => setOwnerWait(true), 10000)
    return () => clearTimeout(id)
  }, [waitingForOwner])

  // 세션 복구 배선: resume → 같은 doc으로 WS 재오픈 (리마운트 없음).
  const wireSessionRecovery = (session: YCollabSession) => {
    session.setRecovery({
      getSession: async () => {
        const c = collabRef.current
        const sp = savePath
        if (!c || !sp) return { kind: 'retry' as const }
        try {
          const info = await collabApi.session(sp, {
            resumeEpoch: c.epoch,
            knownHash: session.knownHash,
            clientId: session.clientId,
          })
          return {
            kind: 'ok' as const,
            info: { roomId: info.roomId, role: info.role, epoch: info.epoch, lastHash: info.lastHash },
          }
        } catch (e) {
          const code = (e as { code?: string })?.code
          if (code === 'external_change' || code === 'epoch_mismatch') {
            return { kind: 'terminal' as const, terminal: code }
          }
          return { kind: 'retry' as const }
        }
      },
      onTerminalError: (kind) => {
        if (kind === 'external_change') {
          setCollabNotice('외부에서 변경됨 — 다시 열기 (자동 병합 없음).')
        } else {
          setCollabNotice('다른 세션이 시작됨 — 다시 열기.')
        }
        void offerMineDownload()
        showToast.error(kind === 'external_change' ? '외부에서 변경됨' : '다른 세션이 시작됨')
      },
    })
    // 3번: 연결 상태는 상단 바의 상태 표시로만 알린다.
    // 끊김/복구는 트레이싱 모드에서만 (평소엔 중복 토스트 금지).
    // terminal 오류는 사용자 행동이 필요하므로 유지.
    session.subscribe(() => {
      const snap = session.getSnapshot()
      setConnBadge({ status: snap.status, synced: snap.synced })
      updateDebug()
      reconcileCollab()
      // R4: sync 직후(재연결 포함) 현재 슬라이드를 1회 게시한다.
      // 이동 전까지 app.slide가 없으면 상대는 lib fallback(=항상 1)을 본다.
  if (snap.synced && !slidePublishedRef.current) {
        slidePublishedRef.current = true
        // H3-2: 새 세션의 첫 위치는 옛 ref가 아니라 viewer 현재 슬라이드로 1회 게시.
        // +1 변환과 표기 문자열은 publishSlideLocation 한 곳에만 있다 (X2 확인).
        publishSlideLocationRef.current?.(curSlideRef.current)
      }
      if (snap.status === 'disconnected' && toastedStatus.current !== 'disconnected') {
        toastedStatus.current = 'disconnected'
        if (collabDebug) showToast.warning('연결이 끊김 — 재연결 중')
      } else if (snap.status === 'connected' && toastedStatus.current === 'disconnected') {
        toastedStatus.current = 'connected'
      } else if (snap.status === 'error' && toastedStatus.current !== 'error') {
        toastedStatus.current = 'error'
        showToast.error('공동편집 오류')
      }
    })
    // Q1: 서버가 방을 해체했다(4001). resume 없이 새로 입장해 파일 기준으로 다시 시작한다.
    session.onReset(() => {
      logClient('room_reset_reload')
      if (collabRef.current?.session === session) {
        // M18: 리셋으로 언마운트되므로 예약된 write-back 을 실행하지 않는다.
        resetInFlightRef.current = true
        writeBackHaltedRef.current = false
        lossPendingRef.current = null
        setImageLoss(null)
        // M2-2: 4001로 방이 해체됐으므로 이 세션은 더 이상 유효하지 않다.
        // 이전에는 여기서 release하지 않아 registry에 항목이 남았고, reloadKey로 재진입할 때
        // acquire가 죽은 세션을 재사용(refs=2)했다. 언마운트 시 release가 1회만 돌아
        // 세션이 영구 생존했다. 항목을 즉시 버려야 한다.
        if (savePath) dropCollabSession(savePath, session)
        collabRef.current = null
        setCollab(null)
        setMetaOwner(null)
        ownerIdRef.current = null
        setMetaTick(0)
        // 파일 바이트로 다시 로드 (reloadKey + 파일 경로 기준으로 세션 재생성).
        setReloadKey((v) => v + 1)
        setSlideIdx(0)
        setCurSlide(0)
        setRenameSessionKey((v) => v + 1)
      }
      showToast.info('owner가 파일 기준으로 다시 열었습니다')
    })
    // Y 슬라이드 수 추적 (doc은 세션 동안 유지되므로 여기서 1회만).
    const onDocUpdate = (): void => updateDebug()
    try {
      session.doc.on('update', onDocUpdate)
    } catch {
      // 무시
    }
    // 서버 meta push 즉시 반영 (폴 5초를 기다리지 않는다 — E9/E10 3초 충족).
    // owner 판정의 단일 진실 통로이기도 하다 (role/intent는 reconcile이 확정).
    session.onMeta((meta) => {
      const c = collabRef.current
      ownerIdRef.current = meta.ownerClientId
      setMetaOwner(meta.ownerClientId)
      setMetaTick((v) => v + 1)
      trackAiBlocked(meta.aiBlockedAt)
      if (meta.externalChanged) {
        setCollabNotice('외부에서 변경됨 — 다시 열기 (자동 병합 없음).')
      }
      if (c && meta.lastHash) {
        baseHashRef.current = meta.lastHash
        session.knownHash = meta.lastHash
      }
      updateDebug()
      reconcileCollab()
    })
  }

  // owner 승계 감지 + 외부변경 배너 + knownHash 갱신 (5초 폴).
  // room 소멸 시 solo로 되돌아가지 않고 resume 플로우로 간다.
  useEffect(() => {
    if (!collab || !savePath) return
    const poll = () => {
      void (async () => {
        const c = collabRef.current
        if (!c) return
        let lock: Awaited<ReturnType<typeof collabApi.lock>> | null = null
        try {
          lock = await collabApi.lock(savePath)
        } catch {
          return
        }
        if (!lock || !lock.active) {
          // P0-3: 참가자는 usePeers가 전담. lock은 AI-blocked만 본다.
          if (lock) {
            trackAiBlocked(lock.aiBlockedAt ?? null)
          }
          updateDebug()
          return // 재연결 루프가 resume 처리
        }
        trackAiBlocked(lock.aiBlockedAt ?? null)
        ownerIdRef.current = (lock.owner ?? [])[0] ?? null
        setMetaOwner(ownerIdRef.current)
        updateDebug()
        if (lock.lastHash) {
          baseHashRef.current = lock.lastHash
          c.session.knownHash = lock.lastHash
        }
        if (lock.externalChanged) {
          setCollabNotice('외부에서 변경됨 — 다시 열기 (자동 병합 없음).')
        }
        // role 판정은 reconcile(meta 기준)이 전담한다 — 여기서 flip·flush·리마운트 금지.
        reconcileCollab()
      })()
    }
    // P1-2: sync 직후 5초를 기다리지 않고 바로 1회 실행한다.
    poll()
    const id = setInterval(poll, 5000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collab, savePath])

  // P1-5: 탭이 숨겨지면 owner는 즉시 flush (모바일 홈 버튼 대응).
  useEffect(() => {
    if (!collab) return
    const onVis = () => {
      const c = collabRef.current
      if (document.visibilityState === 'hidden') {
        if (c && isOwnerNow(c) && c.session.synced) {
          const h = viewerRef.current
          if (h) {
            void h
              .getContent()
              .then((b) => persistBytes(new Uint8Array(b)))
              .catch(() => {})
          }
        }
      } else {
        collabRef.current?.session.poke()
      }
    }
    const onOnline = () => collabRef.current?.session.poke()
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('online', onOnline)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('online', onOnline)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collab])
  useEffect(() => {
    setComments([])
    setShowComments(false)
    setSlideIdx(0)
    setCurSlide(0)
    setSavedBytes(null)
    setDraft('')
    setMineFile((prev) => {
      if (prev) {
        try {
          URL.revokeObjectURL(prev.url)
        } catch {
          // 무시
        }
      }
      return null
    })
    setCollabNotice(null)
  }, [data, setCurSlide])
  useEffect(() => {
    let dead = false
    void loadPptxComments(content).then((cs) => {
      if (dead) return
      setComments(cs)
    })
    return () => {
      dead = true
    }
  }, [content])
  useEffect(() => {
    const onComments = () => {
      setShowComments((v) => !v)
    }
    window.addEventListener('pptxCommentsRequest', onComments)
    return () => window.removeEventListener('pptxCommentsRequest', onComments)
  }, [])
  const openComment = (c: PptxComment) => {
    if (editing) {
      showToast.info('편집 중에는 슬라이드 이동을 하지 않습니다')
      return
    }
    const idx = Math.max(0, c.slideNo - 1)
    setSlideIdx(idx)
    setCurSlide(idx)
    // S4: 리마운트 없이 lib에 이동을 요청한다.
    try {
      viewerRef.current?.goTo?.(idx)
    } catch {
      // 무시
    }
  }
  const addComment = async () => {
    const text = draft.trim()
    if (!text || adding) return
    if (!savePath) {
      showToast.error('저장 경로가 없습니다')
      return
    }
    // 작성자 단일 통로: collab-user 이름 우선, 없으면 기존 단일 작성자.
    const existingAuthors = [...new Set(comments.map((c) => c.author).filter((a) => a && a !== 'Unknown'))]
    const name = authorOrUser || (existingAuthors.length === 1 ? existingAuthors[0]! : '')
    if (!name) {
      showToast.error('작성자 이름을 입력하세요')
      return
    }
    setAdding(true)
    try {
      const target = curSlide + 1
      const ok = await mutatePptxComments((base) =>
        addPptxComment(base, {
          slideNo: target,
          authorName: name,
          text,
        }),
      )
      if (!ok) return
      setDraft('')
      try {
        localStorage.setItem('ppt-comment-author', name)
      } catch {
        /* 무시 */
      }
      setSlideIdx(target - 1)
      setCurSlide(target - 1)
      try {
        viewerRef.current?.goTo?.(target - 1)
      } catch {
        // 무시
      }
      showToast.success('코멘트 저장했습니다')
    } finally {
      setAdding(false)
    }
  }
  // 파일 op 한 번: 편집 중이면 뷰어 모델을 먼저 파일에 굳히고(편집을 날리지 않기 위해),
  // op 적용 → 저장 → 패널 새로고침 → 뷰어 리마운트 순서로 처리한다.
  // 저장은 persistBytes로 일원화한다 (collab 중이면 baseHash 검사).
  const mutatePptxComments = async (
    op: (base: Uint8Array) => Promise<Uint8Array>,
  ): Promise<boolean> => {
    if (!savePath) {
      showToast.error('저장 경로가 없습니다')
      return false
    }
    // P2-1: collaborator는 코멘트 저장 불가 (서버도 409로 막는다).
    if (collabRef.current && collabRef.current.role !== 'owner') {
      showToast.info('공동편집 중에는 owner만 코멘트를 저장할 수 있습니다')
      return false
    }
    // 세션 밖에서 저장하는데 누군가 편집 중이면 base가 stale이라 덮어쓴다. 차단.
    if (!collabRef.current) {
      try {
        const lock = await collabApi.lock(savePath)
        if (lock.active) {
          setCollabNotice('Someone is editing — join edit mode to participate.')
          return false
        }
      } catch {
        // 조회 실패는 통과 (fail-open)
      }
    }
    try {
      // S3: collab 중 content는 고정되므로 최신 저장본을 base로 쓴다.
      let base = latestSavedRef.current ?? content
      if (editing) {
        const h = viewerRef.current
        if (!h) return false
        const cur = new Uint8Array(await h.getContent())
        if (!(await persistBytes(cur))) return false
        base = cur
      }
      const next = await op(base)
      if (!(await persistBytes(new Uint8Array(next)))) return false
      // S3: collab 중에는 content 고정 (세션 종료 때 반영).
      if (collabRef.current) latestSavedRef.current = next
      else setSavedBytes(next)
      const cs = await loadPptxComments(next)
      setComments(cs)
      // P2-2: collab 중 리마운트 금지 — 같은 doc을 다시 seed할 위험이 있다.
      if (!collabRef.current) setReloadKey((v) => v + 1)
      return true
    } catch (e) {
      showToast.error(e instanceof Error ? e.message : '코멘트 저장 실패')
      return false
    }
  }
  const [replyTo, setReplyTo] = useState<string | null>(null)
  const [replyDraft, setReplyDraft] = useState('')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [deleteArm, setDeleteArm] = useState<string | null>(null)
  const sendReply = async (parent: PptxComment) => {
    const text = replyDraft.trim()
    if (!text || busyId) return
    if (parent.format !== 'modern') {
      showToast.info('레거시 코멘트 답글은 지원하지 않습니다')
      return
    }
    setBusyId(`reply:${parent.cid}`)
    try {
      const existingAuthors = [...new Set(comments.map((c) => c.author).filter((a) => a && a !== 'Unknown'))]
      const name = authorOrUser || (existingAuthors.length === 1 ? existingAuthors[0]! : '')
      if (!name) {
        showToast.error('작성자 이름을 입력하세요')
        return
      }
      const ok = await mutatePptxComments((base) =>
        replyPptxComment(base, { parentCid: parent.cid, authorName: name, text }),
      )
      if (ok) {
        setReplyTo(null)
        setReplyDraft('')
        showToast.success('답글 저장했습니다')
      }
    } finally {
      setBusyId(null)
    }
  }
  const toggleResolve = async (c: PptxComment) => {
    if (busyId || c.format !== 'modern') return
    setBusyId(`resolve:${c.cid}`)
    try {
      await mutatePptxComments((base) =>
        setPptxCommentDone(base, { cid: c.cid, done: !c.resolved }),
      )
    } finally {
      setBusyId(null)
    }
  }
  const toggleResolveReply = async (c: PptxComment, r: { cid: string; resolved: boolean }) => {
    if (busyId || c.format !== 'modern') {
      if (c.format !== 'modern') showToast.info('레거시 코멘트 해결 표시는 지원하지 않습니다')
      return
    }
    setBusyId(`resolve:${r.cid}`)
    try {
      await mutatePptxComments((base) =>
        setPptxCommentDone(base, { cid: r.cid, done: !r.resolved }),
      )
    } finally {
      setBusyId(null)
    }
  }
  const saveEdit = async (c: PptxComment) => {
    const text = editDraft.trim()
    if (!text || busyId) return
    setBusyId(`edit:${c.cid}`)
    try {
      await mutatePptxComments((base) => editPptxComment(base, { cid: c.cid, text }))
      setEditingId(null)
    } finally {
      setBusyId(null)
    }
  }
  const saveReplyEdit = async (r: { cid: string }) => {
    const text = editDraft.trim()
    if (!text || busyId) return
    setBusyId(`edit:${r.cid}`)
    try {
      await mutatePptxComments((base) => editPptxComment(base, { cid: r.cid, text }))
      setEditingId(null)
    } finally {
      setBusyId(null)
    }
  }
  const doDeleteReply = async (r: { cid: string }) => {
    if (busyId) return
    if (deleteArm !== r.cid) {
      setDeleteArm(r.cid)
      return
    }
    setDeleteArm(null)
    setBusyId(`delete:${r.cid}`)
    try {
      await mutatePptxComments((base) => deletePptxComment(base, r.cid))
    } finally {
      setBusyId(null)
    }
  }
  const doDelete = async (c: { cid: string; format: string }) => {
    if (busyId) return
    if (deleteArm !== c.cid) {
      setDeleteArm(c.cid)
      return
    }
    setDeleteArm(null)
    setBusyId(`delete:${c.cid}`)
    try {
      await mutatePptxComments((base) => deletePptxComment(base, c.cid))
    } finally {
      setBusyId(null)
    }
  }
  const [pw, setPw] = useState('')
  const [pwError, setPwError] = useState<string | null>(null)
  const [unlocking, setUnlocking] = useState(false)
  const unlock = async () => {
    if (!pw || unlocking) return
    setUnlocking(true)
    setPwError(null)
    try {
      const { decryptPptx } = await import('ooxml-core/pptx')
      const dec = await decryptPptx(content.buffer as ArrayBuffer, pw)
      setUnlocked(new Uint8Array(dec))
    } catch (e) {
      setPwError(e instanceof Error ? e.message : 'Failed to decrypt')
    } finally {
      setUnlocking(false)
    }
  }
  // P0-2 마운트 게이트: 편집 모드는 synced+meta 수신 전에는 collab 없이 solo로
  // 마운트한다 (판정 전 seed 금지). 보기 모드는 게이트 없이 바로 붙는다.
  const collabGated = !editing || (connBadge.synced && metaTick > 0)
  const isDecrypted = unlocked !== null
  const collaboration = useMemo(
    () =>
      collabUser
      ? buildCollaborationConfig(collabGated ? collab : null, {
          editing,
          viewing: !editing,
          user: { name: collabUser.name, color: collabUser.color },
          isDecrypted,
          writeBackDebounceMs: 2500,
          // M18: 4001 리셋으로 언마운트될 때는 예약된 write-back 을 실행하지 않는다
          // (버린 방의 내용이 새 세션으로 저장되면 리셋이 무효가 된다).
          flushOnUnmount: !resetInFlightRef.current,
          onWriteBack: (bytes: Uint8Array) => {
            void handleWriteBack(bytes)
          },
        })
        : undefined,
    [collabGated, collab, editing, collabUser, isDecrypted, handleWriteBack],
  )
  const viewerRootRef = useRef<HTMLDivElement | null>(null)

  // P0-3: selectedId → 도형 이름. Y doc을 BFS로 뒤져 id가 같은 엘리먼트의
  // name/title/text를 읽는다 (필드 근거는 런타임 덤프로 확인 — E3에서 검증).
  const getSelectedLabel = useCallback((selectedId: string): string | undefined => {
    const c = collabRef.current
    if (!c) return undefined
    try {
      const slides = c.session.doc.getArray('pptx:slides') as unknown as {
        get(i: number): unknown
        length: number
      }
      const seen = new Set<unknown>()
      const queue: unknown[] = []
      for (let i = 0; i < slides.length; i++) queue.push(slides.get(i))
      let depth = 0
      const labelOf = (m: Record<string, unknown>): string | undefined => {
        const name = m['name']
        if (typeof name === 'string' && name) return name.slice(0, 24)
        const title = m['title']
        if (typeof title === 'string' && title) return title.slice(0, 24)
        const text = m['text']
        if (typeof text === 'string' && text.trim()) return text.trim().slice(0, 24)
        if (text && typeof (text as { toString?: unknown }).toString === 'function' && !Array.isArray(text)) {
          try {
            const s = String((text as { toString(): string }).toString())
            if (s.trim()) return s.trim().slice(0, 24)
          } catch {
            // 무시
          }
        }
        return undefined
      }
      while (queue.length > 0 && depth < 6) {
        depth += 1
        const cur = queue.shift()
        if (!cur || typeof cur !== 'object' || seen.has(cur)) continue
        seen.add(cur)
        const rec = cur as Record<string, unknown>
        const get = (rec as { get?: (k: string) => unknown }).get
        if (typeof get === 'function') {
          let id: unknown
          try {
            id = (rec as { get: (k: string) => unknown }).get('id')
          } catch {
            id = undefined
          }
          if (id === selectedId) {
            const asRec: Record<string, unknown> = {}
            for (const k of ['name', 'title', 'text']) {
              try {
                asRec[k] = (rec as { get: (k: string) => unknown }).get(k)
              } catch {
                // 무시
              }
            }
            return labelOf(asRec)
          }
          for (const k of ['elements', 'children', 'shapes']) {
            try {
              const arr = (rec as { get: (k: string) => unknown }).get(k) as {
                get?(i: number): unknown
                length?: number
              } | null
              if (arr && typeof arr.length === 'number') {
                for (let i = 0; i < arr.length; i++) {
                  try {
                    const item = typeof arr.get === 'function' ? arr.get(i) : (arr as unknown[])[i]
                    if (item) queue.push(item)
                  } catch {
                    // 무시
                  }
                }
              }
            } catch {
              // 무시
            }
          }
        } else if (Array.isArray(cur)) {
          for (const item of cur) queue.push(item)
        }
      }
    } catch {
      // 무시
    }
    return undefined
  }, [])

  // P0-3: 참가자는 로컬 awareness에서 직접 읽는다 (서버 poll 불필요).
  const peers = usePeers(collab?.session ?? null, {
    ownerClientId: metaOwner,
    selfUserId: collab?.userId ?? '',
    getSelectedLabel: (id) => getSelectedLabel(id),
  })
const peersRef = useRef<Peer[]>([])
  peersRef.current = peers
  // Z3: 상대 슬라이드 이력 — awareness로 받은 값이 **변경될 때마다** 기록한다.
  // 200ms 샘플링은 그보다 짧은 깜빡임을 놓치므로 이벤트 기준으로 본다.
  const peerSlideHistoryRef = useRef<Record<string, number[]>>({})
  const peerSlideLastRef = useRef<Record<string, number | null>>({})
  for (const p of peers) {
    const last = peerSlideLastRef.current[p.id] ?? null
    if ((p.slide ?? null) !== last) {
      peerSlideLastRef.current[p.id] = p.slide ?? null
      const h = peerSlideHistoryRef.current[p.id] ?? (peerSlideHistoryRef.current[p.id] = [])
      h.push(p.slide ?? -1)
      if (h.length > 100) h.shift()
    }
  }

  /** 위치 게시 1회 (H1). slide와 where를 한 awareness update로 낸다. */
  const publishSlideLocation = useCallback((index0: number) => {
    const n = index0 + 1
    // 호출 시점에 collabRef를 읽어 오래된 세션을 붙잡지 않는다.
    collabRef.current?.session.setLocation({ slide: n, where: formatWhere('pptx', n) })
  }, [])
  // 세션 구독 콜백이 선언보다 앞서 만들어지므로 ref로 먼저 참조한다 (X2 확인).
  const publishSlideLocationRef = useRef<((index0: number) => void) | null>(null)
  publishSlideLocationRef.current = publishSlideLocation

/**
 * W1 게이트: curSlideRef와 state를 즉시 갱신하고, 0 게시만 300ms 늦춘다.
 * slideIdx(initialSlide)는 여기서 건드리지 않는다 — setViewerRef가 마운트 시에만 갱신한다.
 * (로직은 frontend/src/lib/slideLocationGate.ts — 단위 테스트가 같은 모듈을 쓴다.)
 */
  const slideGateRef = useRef<ReturnType<typeof createSlideGate> | null>(null)
  if (!slideGateRef.current) {
    slideGateRef.current = createSlideGate({
      getCurrent: () => curSlideRef.current,
      applyLocal: (i) => {
        // W1-a: 렌더 타이밍에 의존하지 않게 ref를 먼저 갱신한다.
        // X2: setSlideIdx는 여기서 부르지 않는다. initialSlide prop은 lib이 파일 로드
        // 완료 시에만 읽고(chunk-552NAFTD.js:4468 ref 덮어쓰기 → :4622 resolveInitialSlideIndex)
        // deps에도 없어 기능 문제는 없지만, 이동마다 prop이 바뀌면 불필요한 리렌더가 생긴다.
        // 리마운트 직전에만 갱신한다 (viewerKey 변경 지점의 useEffect).
        curSlideRef.current = i
        setCurSlide(i)
      },
      publish: (i) => publishSlideLocation(i),
    })
  }
  // Z1: 안정적 identity. lib effect의 deps에 들어 있으므로(L11263) 렌더마다 바뀌면
  // 매 렌더마다 activeSlideIndex가 재방출된다 (W1-b가 그 튐을 상쇄한다).
  // Z3: 마운트(=disarm)부터 arm까지 걸린 시간. slow-parse 테스트가
  // "실제로 300ms를 넘겼는지"(=게이트 300ms 창이 의미 있었는지)를 확인한다.
  const armedAtRef = useRef<number | null>(null)
  const armDelayRef = useRef<number | null>(null)
  const handleActiveSlideChange = useCallback((i: number) => {
    // W1: 게이트 모듈이 cur 반영(즉시)과 게시(0은 300ms 지연)를 함께 처리한다.
    // Y2: arm 전에는 이 호출이 전부 무시된다.
    slideGateRef.current?.onIndex(i)
  }, [])

  useEffect(() => {
    return () => slideGateRef.current?.dispose()
  }, [savePath])

  // 팔로우: 선택한 사람의 슬라이드로 계속 따라간다 (선택한 경우에만 이동).
  const [followId, setFollowId] = useState<string | null>(null)
  const followed = followId ? peers.find((p) => p.id === followId) ?? null : null
  useEffect(() => {
    // 대상이 나가거나 슬라이드 정보가 없으면 추적을 멈춘다.
    if (followId && !peers.some((p) => p.id === followId)) setFollowId(null)
  }, [peers, followId])
  useEffect(() => {
    const s = followed?.slide
    if (!followId || typeof s !== 'number' || s < 1) return
    if (slideIdx === s - 1) return
    setSlideIdx(s - 1)
    setCurSlide(s - 1)
    try {
      viewerRef.current?.goTo?.(s - 1)
    } catch {
      // 무시 (fallback: initialSlide는 다음 마운트에 반영)
    }
  }, [followId, followed?.slide, setCurSlide])

  // P0-3: 입장/퇴장/모드전환은 트레이싱 모드에서만 (평소엔 상단 바가 알린다).
  const peerToastAt = useRef<Map<string, number>>(new Map())
  const prevPeersRef = useRef<Map<string, string>>(new Map())
  useEffect(() => {
    if (!collab) return
    if (!collabDebug) {
      prevPeersRef.current = new Map(peers.map((p) => [p.id, p.mode]))
      return
    }
    const prev = prevPeersRef.current
    const now = new Map<string, string>()
    const at = Date.now()
    for (const p of peers) {
      now.set(p.id, `${p.mode}`)
      if (p.isSelf) continue
      const was = prev.get(p.id)
      const lastToast = peerToastAt.current.get(p.id) ?? 0
      if (was === undefined && at - lastToast > 5000) {
        peerToastAt.current.set(p.id, at)
        showToast.info(`${p.name}님이 ${p.mode === 'edit' ? '편집에' : '보기에'} 참여했습니다`)
      } else if (was !== undefined && was !== p.mode && at - lastToast > 5000) {
        peerToastAt.current.set(p.id, at)
        showToast.info(`${p.name}님이 ${p.mode === 'edit' ? '편집에' : '보기에'} 참여했습니다`)
      }
    }
    for (const [id] of prev) {
      if (!now.has(id) && at - (peerToastAt.current.get(id) ?? 0) > 5000) {
        peerToastAt.current.set(id, at)
        showToast.info('참가자가 나갔습니다')
      }
    }
    prevPeersRef.current = now
  }, [peers, collab])

  // P0-3: 같은 도형 선택 경고 (막지는 않는다).
  const mySelectedId = (() => {
    try {
      const c = collabRef.current
      const local = c?.session.awareness.getLocalState() as Record<string, unknown> | null
      const pres = (local?.presence ?? null) as { selectedElementId?: unknown } | null
      return typeof pres?.selectedElementId === 'string' ? pres.selectedElementId : null
    } catch {
      return null
    }
  })()
  const sameShapePeers = mySelectedId
    ? peers.filter((p) => !p.isSelf && p.selectedId === mySelectedId)
    : []

  // E2E: PowerPointViewer 마운트 횟수 (?collabDebug=1일 때만).
  // viewer key가 바뀌면 리마운트되므로 key 문자열을 deps로 둔다.
  // S4: slideIdx를 key에서 뺀다 — 이동은 lib goTo API로 한다 (리마운트 금지).
  const viewerKey = `${editing ? 'edit' : 'view'}#${reloadKey}#${collabGated && collab ? collab.roomId : 'solo'}`
  // Y2: slideIdx(=lib의 initialSlide)는 key가 바뀌는 렌더에서만 갱신한다.
  // edit↔view 전환·reloadKey bump·4001 재생성이 모두 viewerKey에 포함되어 있고,
  // `editing`은 외부 prop이라 "바꾸기 직전"에 실행할 코드를 소유할 수 없다.
  // React의 "props 변경 시 state 보정" 패턴으로, 자식 렌더 **이전**에 값을 고정한다.
  // render 중 ref 읽기는 React가 권장하지 않지만, 여기서는 커밋 이전 값이 필요한 유일한
  // 지점이고 부작용이 없다(읽기 전용). 다른 곳에서는 쓰지 않는다.
  // 무한 루프가 나지 않는 이유: key에 slideIdx가 없다(S4=97db6e9가 제거). 이 블록은
  // viewerKey가 바뀔 때만 실행되고, 실행 후 prevViewerKey가 즉시 일치한다.
  const [prevViewerKey, setPrevViewerKey] = useState(viewerKey)
  if (prevViewerKey !== viewerKey) {
    // M11 계측: viewerKey 변경(리마운트 원인). 구성요소별 차이를 남긴다.
    tl('viewerKey.change', {
      prev: prevViewerKey,
      next: viewerKey,
      editing: !!editing,
      reloadKey,
      collabGated: !!collabGated,
      roomId: collab?.roomId ?? null,
      solo: !(collabGated && collab),
    })
    // M11: 리마운트 후 첫 자동 저장은 구(舊) 내용으로 덮어쓸 수 있어 막는다.
    remountedSinceSaveRef.current = true
    setPrevViewerKey(viewerKey)
    setSlideIdx(curSlideRef.current)
  }
  useEffect(() => {
    if (!collabDebug) return
    try {
      const w = window as unknown as { __collabDebug?: Record<string, unknown> }
      w.__collabDebug = {
        ...(w.__collabDebug ?? {}),
        mountCount: ((w.__collabDebug?.mountCount as number | undefined) ?? 0) + 1,
      }
    } catch {
      // 무시
    }
  }, [viewerKey, collabDebug])

  // E3: lib 원격 선택 오버레이에 계약 testid를 붙인다.
  // lib 근거: pptx-react-viewer chunk-552NAFTD.js RemoteSelectionOverlay —
  //   data-testid={`remote-selection-${sel.element.id}`},
  //   data-pptx-remote-selection={sel.element.id} (border색+이름 라벨 포함).
  // peer 판별은 border색→참가자 color 매칭, 폴백은 이름 라벨 매칭이다.
  useEffect(() => {
    if (!collab) return
    const root = viewerRootRef.current
    if (!root) return
    const toHex = (css: string): string => {
      const m = css.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i)
      if (m) {
        const h = (n: number): string => n.toString(16).padStart(2, '0')
        return `#${h(Number(m[1]))}${h(Number(m[2]))}${h(Number(m[3]))}`.toLowerCase()
      }
      return css.trim().toLowerCase()
    }
    const tag = (el: Element): void => {
      try {
        if (el.getAttribute('data-testid') === 'collab-remote-selection') return
        const html = el as HTMLElement
        let peerId: string | null = null
        const border = html.style.borderColor || window.getComputedStyle(html).borderColor
        const hex = toHex(border)
        const byColor = peersRef.current.find((p) => p.color.toLowerCase() === hex)
        if (byColor) {
          peerId = byColor.id
        } else {
          const label = el.querySelector('span')?.textContent?.trim() ?? ''
          const byName = label
            ? peersRef.current.find((p) => p.name === label)
            : undefined
          if (byName) peerId = byName.id
        }
        el.setAttribute('data-testid', 'collab-remote-selection')
        if (peerId) el.setAttribute('data-peer-id', peerId)
      } catch {
        // 무시
      }
    }
    const sweep = (node: ParentNode): void => {
      node.querySelectorAll('[data-pptx-remote-selection]').forEach(tag)
    }
    sweep(root)
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n instanceof Element) {
            if (n.hasAttribute('data-pptx-remote-selection')) tag(n)
            sweep(n)
          }
        }
      }
    })
    mo.observe(root, { childList: true, subtree: true })
    return () => mo.disconnect()
  }, [collab, peers])

  // P0-3: 슬라이드 점 (썸네일 + 모바일 시트 공용 앵커).
  // lib 근거 (scratch DOM 덤프 2026-10-15):
  //   ASIDE[role=navigation][aria-label=Slides] 하위 BUTTON[aria-label="Go to slide N"].
  // lib 리렌더가 점을 지우므로 MutationObserver로 다시 그린다 (冪等).
  useEffect(() => {
    if (!collab) return
    const root = viewerRootRef.current
    if (!root) return
    const paint = (): void => {
      try {
        const bySlide = new Map<number, Peer[]>()
        for (const p of peersRef.current) {
          if (p.slide == null) continue
          const arr = bySlide.get(p.slide) ?? []
          arr.push(p)
          bySlide.set(p.slide, arr)
        }
        const btns = root.querySelectorAll('button[aria-label^="Go to slide "]')
        btns.forEach((btn) => {
          const m = (btn.getAttribute('aria-label') || '').match(/Go to slide (\d+)/)
          if (!m) return
          const list = bySlide.get(Number(m[1])) ?? []
          const html = btn as HTMLElement
          // M7-2: paint는 멱등이어야 한다.
          // 예전 구현은 점 span을 매번 지우고 새로 만들었다. 그 결과
          // (1) 아래 MutationObserver가 우리가 만든 변경을 다시 잡아 300ms마다
          //     paint가 반복되는 자기 루프가 되고,
          // (2) getComputedStyle이 강제 리플로우를 걸어 24장짜리 SVG 트리가
          //     초당 여러 번 레이아웃되며, 그 레이아웃 객체가 GC를 기다리며
          //     렌더러 private 메모리가 sawtooth로 증가했다(작업관리자 +10MB/초).
          // 이제 필요한 점만 만들고, 바뀌었을 때만 속성을 쓴다.
          const want = list.slice(0, 3)
          const wantIds = new Set(want.map((p) => p.id))
          const existing = new Map<string, HTMLElement>()
          btn.querySelectorAll('[data-collab-slide-dot]').forEach((d) => {
            const el = d as HTMLElement
            const key = el.getAttribute('data-collab-slide-dot') ?? ''
            if (key === 'more') return
            existing.set(key, el)
          })
          existing.forEach((el, id) => {
            if (!wantIds.has(id)) el.remove()
          })
          btn.querySelectorAll('[data-collab-slide-dot="more"]').forEach((d) => {
            if (list.length <= 3) d.remove()
          })
          if (list.length === 0) return
          // 강제 리플로우를 피한다. getComputedStyle은 레이아웃을 강제한다.
          // 우리가 직접 relative로 맞추므로 인라인 스타일만 보면 된다.
          if (html.style.position !== 'relative') html.style.position = 'relative'
          want.forEach((p, i) => {
            const recent = p.lastEditAt != null && Date.now() - p.lastEditAt < 3000
            const style =
              `display:inline-block;width:8px;height:8px;border-radius:9999px;background:${p.color};` +
              `position:absolute;right:${2 + i * 10}px;top:2px;border:1px solid #fff;z-index:5;` +
              (recent ? `box-shadow:0 0 0 2px ${p.color}55;` : '')
            const cls = recent ? 'animate-pulse' : ''
            const dot = existing.get(p.id)
            if (dot) {
              if (dot.getAttribute('style') !== style) dot.setAttribute('style', style)
              if (dot.className !== cls) dot.className = cls
              if (dot.title !== p.name) dot.title = p.name
              return
            }
            const el = document.createElement('span')
            el.setAttribute('data-collab-slide-dot', p.id)
            el.title = p.name
            el.className = cls
            el.setAttribute('style', style)
            html.appendChild(el)
          })
          if (list.length > 3) {
            const moreStyle =
              'position:absolute;right:2px;top:12px;font-size:9px;line-height:1;z-index:5;background:rgba(0,0,0,.55);color:#fff;border-radius:6px;padding:1px 3px;'
            const text = `+${list.length - 3}`
            let more = btn.querySelector('[data-collab-slide-dot="more"]') as HTMLElement | null
            if (!more) {
              more = document.createElement('span')
              more.setAttribute('data-collab-slide-dot', 'more')
              more.setAttribute('style', moreStyle)
              html.appendChild(more)
            }
            if (more.textContent !== text) more.textContent = text
          }
        })
      } catch {
        // 무시
      }
    }
    paint()
    let timer: ReturnType<typeof setTimeout> | null = null
    const mo = new MutationObserver(() => {
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        paint()
      }, 300)
    })
    mo.observe(root, { childList: true, subtree: true })
    return () => {
      if (timer) clearTimeout(timer)
      mo.disconnect()
    }
  }, [collab, peers])

  if (!unlocked && isEncryptedOle(content)) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center px-6 gap-3">
        <p className="text-sm text-foreground font-medium">암호로 보호된 파일입니다</p>
        <p className="text-xs text-muted-foreground">열람용 암호를 입력하세요 (사내 DRM 문서는 열 수 없습니다)</p>
        <input
          type="password"
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') void unlock() }}
          placeholder="암호"
          className="h-8 w-56 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        />
        {pwError && <p className="text-xs text-destructive">{pwError}</p>}
        <Button size="sm" onClick={() => void unlock()} disabled={!pw || unlocking}>
          {unlocking ? '여는 중…' : '열기'}
        </Button>
      </div>
    )
  }

  return (
    <div
      ref={viewerRootRef}
      data-testid="pptx-viewer-root"
      className={`relative h-full min-h-[480px]${editing ? '' : ' pptx-preview-compact'}`}
    >
      {isDecrypted && editing && (
        <div className="px-3 py-1.5 border-b border-border text-[11px] text-muted-foreground">
          Encrypted documents cannot be co-edited — editing solo.
        </div>
      )}
      {/* 대기 배너는 띄우지 않는다 (앱 전역 연결 표시가 이미 있고, 로딩 화면이 PPT 위에 겹쳐 보임).
    10초 넘게 owner 응답이 없었을 때만 조용히 재시도 affordance를 남긴다. */}
      {collab && ownerWait && (
        <div className="px-3 py-1 border-b border-border text-[11px] text-muted-foreground">
          <button
            type="button"
            data-testid="collab-owner-retry"
            onClick={() => {
              setOwnerWait(false)
              collabRef.current?.session.reconnect()
            }}
            className="shrink-0 underline underline-offset-2 hover:text-foreground"
          >
            다시 시도
          </button>
        </div>
      )}
      {collab && (
        // 상태는诊断용 속성(data-status)으로만 남긴다. 화면 배너는 중복 표시하지 않는다
        // (앱 전역 연결 표시가 이미 있고, 같은 내용을 두 번 띄우면 혼란).
        <div
          data-testid="collab-status"
          data-status={!online ? 'offline' : connBadge.status === 'disconnected' ? 'reconnecting' : connBadge.status}
          className="hidden"
        />
      )}
      {collab && (
        <CollabPresenceShell>
        <div data-testid="collab-presence-bar" className="flex items-center gap-2 px-3 py-1 border-b border-border text-[11px] text-muted-foreground overflow-x-auto">
          {/* M7-2: 시각 갱신은 이 아래로만 전파한다. 칩만 다시 그려지고
              PptxViewer(덱 트리)는 다시 그려지지 않는다.
              M7-4: 아무도 편집 중이 아니면 5초 주기로 느슨하게 돌린다. */}
          <NowProvider
            active={peers.some((p) => !p.isSelf && p.lastEditAt != null && Date.now() - p.lastEditAt < 10_000)}
          >
          {(['view', 'edit'] as const).map((mode, gi) => {
            const group = peers.filter((p) => p.mode === mode && !p.isSelf)
            return (
              <span key={mode} className="inline-flex items-center gap-1 shrink-0">
                {gi > 0 && <span className="mx-1">·</span>}
                <span className="font-medium">{mode === 'view' ? 'viewer' : 'editor'} -</span>
                {group.map((p) => (
                  <CollabPeerChip
                    key={p.id}
                    p={p}
                    following={followId === p.id}
                    onFollow={() => {
                      // 팔로우 토글: 선택한 사람만 계속 따라간다. 해제하면 그만 따른다.
                      if (followId === p.id) {
                        setFollowId(null)
                        return
                      }
                      setFollowId(p.id)
                      if (typeof p.slide === 'number' && p.slide >= 1) {
                        setSlideIdx(p.slide - 1)
                        setCurSlide(p.slide - 1)
                        try {
                          viewerRef.current?.goTo?.(p.slide - 1)
                        } catch {
                          // 무시 (fallback: initialSlide는 다음 마운트에 반영).
                        }
                      }
                    }}
                  />
                ))}
              </span>
            )
          })}
          {followed && (
            <span
              data-testid="collab-following"
              className="inline-flex items-center gap-1 shrink-0 text-foreground"
            >
              <Eye className="w-3 h-3" />
              <span className="truncate max-w-[120px]">{followed.name}</span>
              <button
                type="button"
                data-testid="collab-follow-stop"
                title="팔로우 해제"
                onClick={() => setFollowId(null)}
                className="underline underline-offset-2 hover:text-muted-foreground"
              >
                해제
              </button>
            </span>
          )}
          {(() => {
            const self = peers.find((p) => p.isSelf)
            if (!self) return null
            return (
              <span className="inline-flex items-center gap-1 shrink-0 ml-auto">
                <span
                  className="inline-block w-2 h-2 rounded-full"
                  style={{ backgroundColor: self.color }}
                />
                {renaming ? (
                  <span className="inline-flex items-center gap-1">
                    <input
                      value={renameInput}
                      autoFocus
                      data-testid="collab-rename-input"
                      onChange={(e) => setRenameInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') submitRename()
                        if (e.key === 'Escape') setRenaming(false)
                      }}
                      placeholder="Name"
                      className="h-6 w-28 rounded border border-input bg-background px-2 text-[11px] outline-none"
                    />
                    <button
                      type="button"
                      data-testid="collab-rename-submit"
                      onClick={submitRename}
                      className="underline underline-offset-2 hover:text-foreground"
                    >
                      저장
                    </button>
                  </span>
                ) : (
                  <span>
                    나: {self.name}{' '}
                    <button
                      type="button"
                      data-testid="collab-rename-edit"
                      title="이름 변경"
                      onClick={() => {
                        setRenameInput(self.name)
                        setRenaming(true)
                      }}
                      className="inline-flex items-center hover:text-foreground"
                    >
                      <Pencil className="w-3 h-3" />
                    </button>
                  </span>
                )}
                <CollabSelfMarker peer={self} />
              </span>
            )
          })()}
          </NowProvider>
        </div>
        </CollabPresenceShell>
      )}
      {collab && sameShapePeers.length > 0 && (
        <div className="px-3 py-1 border-b border-border text-[11px] text-muted-foreground">
          {sameShapePeers.map((p) => p.name).join(', ')}도 이 도형을 편집 중
        </div>
      )}
      {aiBlocked && (
        <div data-testid="collab-ai-blocked" className="px-3 py-1 border-b border-border text-[11px] text-muted-foreground">
          AI 대기 중
        </div>
      )}
{collabNotice && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-amber-500/40 bg-amber-500/10 text-[11px] text-amber-600 dark:text-amber-400">
          <span className="flex-1">{collabNotice}</span>
          {resetConfirmCount != null && (
            <span data-testid="collab-reset-confirm" className="inline-flex items-center gap-1">
              <span>
                참가자 {resetConfirmCount}명의 저장되지 않은 변경이 사라집니다. 계속할까요?
              </span>
              <button
                type="button"
                data-testid="collab-reset-confirm-yes"
                onClick={() => doResetRoom()}
                className="underline underline-offset-2"
              >
                진행
              </button>
              <button
                type="button"
                onClick={() => setResetConfirmCount(null)}
                className="underline underline-offset-2"
              >
                취소
              </button>
            </span>
          )}
{(imageLoss || lossPendingRef.current) &&
            (isResetOwner ? (
              <button
                type="button"
                data-testid="collab-reset-room"
                onClick={() => requestRoomReset()}
                className="shrink-0 underline underline-offset-2 hover:text-amber-500"
              >
                파일 기준으로 다시 열기
              </button>
            ) : (
              <span data-testid="collab-reset-hint" className="shrink-0 opacity-80">
                owner에게 다시 열기를 요청하세요
              </span>
            ))}
          {lossPendingRef.current && (
            <button
              type="button"
              data-testid="collab-confirm-image-loss"
              onClick={() => void confirmImageLossSave()}
              className="shrink-0 underline underline-offset-2 hover:text-amber-500"
            >
              이미지 삭제가 맞습니다 — 저장
            </button>
          )}
          {mineFile && (
            <a
              href={mineFile.url}
              download={mineFile.name}
              className="shrink-0 underline underline-offset-2 hover:text-amber-500"
            >
              내 사본 다운로드
            </a>
          )}
          <button
            type="button"
            onClick={() => setCollabNotice(null)}
            className="shrink-0 underline underline-offset-2 hover:text-amber-500"
          >
            Dismiss
          </button>
        </div>
      )}
      <div className="flex h-full min-h-0">
        <div className="flex-1 min-w-0 h-full">
          <PptxViewerBoundary onFail={onFail}>
            <Suspense fallback={SPINNER}>
              <I18nextProvider i18n={pptxI18n}>
                <PowerPointViewer
                  key={viewerKey}
                  ref={setViewerRef}
                  content={unlocked ?? content}
                  fileName={fileName}
                  canEdit={editing}
                  showToolbar={editing || narrowViewport}
                  // U2: 앱이 관리하는 저장(소유자 write-back)만 남긴다 — lib 타이틀바의
                  // AutoSave 표시/토글은 제거(ooxml-ui 패치: 호스트가 끄면 표시 안 함).
                  autosave={false}
                  // U2: Done/Save/Comments 를 기능 search 오른쪽(actions 슬롯)에 투영한다.
                  titleBarSlot={titleBarSlot}
                  theme={viewerTheme}
                  initialSlide={slideIdx}
                  // Y2: arm 신호. deps가 [slides.length]라 parse 전 0으로도 호출되므로
                  // count > 0일 때만 "덱이 다 파싱됐다"고 본다
                  // (chunk-552NAFTD.js:11284-11286).
                  onSlideCountChange={(count: number) => {
                    if (count <= 0) return // Z1: 슬라이드가 0장이 되어도 disarm하지 않는다.
                    const gate = slideGateRef.current
                    if (gate && !gate.armed()) {
                      // Z3: 첫 arm에서만 소요 시간을 잰다 (이후 arm은 재해석이 아니다).
                      if (armedAtRef.current !== null) {
                        armDelayRef.current = Math.round(performance.now() - armedAtRef.current)
                      }
                    }
                    gate?.arm()
                    // Z1: parse 커밋에서 lib effect 순서는 onActiveSlideChange(L11259)가
                    // onSlideCountChange(L11284)보다 **먼저**다. 즉 진짜 초기 index는
                    // disarm 상태로 지나간다. arm 직후 lib의 실제 index를 한 번 동기화한다.
                    // handle.getActiveSlideIndex()(L11136)는 clamp가 반영된 값이다.
                    const idx = (viewerRef.current as { getActiveSlideIndex?: () => number } | null)
                      ?.getActiveSlideIndex?.()
                    if (typeof idx === 'number' && idx !== curSlideRef.current) gate?.onIndex(idx)
                  }}
                  onActiveSlideChange={handleActiveSlideChange}
                  onContentChange={() => void onViewerContentChange()}
                  collaboration={collaboration}
                  // 2-1: lib 내장 presence 아바타/공유 버튼을 끈다 (우리 상단 바 하나만 남긴다).
                  // 근거: chunk-JL7A7NDD.js UserAvatarBar(L77, data-testid="user-avatar-bar")
                  // 는 툴바 share 버튼에서만 렌더되며(L4053), 그 렌더 조건이
                  // pptx.isDialogAvailable(customization, "share") 다 (ooxml-ui chunk-MCHPNO42.mjs L51915).
                  customization={PPT_CUSTOMIZATION}
                />
              </I18nextProvider>
            </Suspense>
          </PptxViewerBoundary>
        </div>
        {showComments && (
          <div data-pptx-comments className="absolute right-0 top-0 bottom-0 w-72 z-30 border-l border-border bg-background flex flex-col min-h-0">
            <div className="px-3 py-2 border-b border-border text-xs font-medium flex-shrink-0 flex items-center gap-1">
              <span className="flex-1">코멘트 ({comments.length})</span>
              <button
                type="button"
                onClick={() => void refreshComments()}
                className="inline-flex items-center justify-center h-6 w-6 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
                title="다시 읽기"
              >
                <RefreshCw className="w-3 h-3" />
              </button>
            </div>
            <div className="p-2 border-b border-border flex-shrink-0 space-y-1.5">
              <input
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
                placeholder="이름"
                className="h-7 w-full rounded-md border border-input bg-background px-2 text-xs outline-none"
              />
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={`코멘트 입력 (슬라이드 ${curSlide + 1})`}
                rows={2}
                className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs outline-none resize-none"
              />
              <Button
                size="sm"
                className="w-full h-7 text-xs"
                disabled={!draft.trim() || adding || (collab !== null && collab.role !== 'owner')}
                title={collab !== null && collab.role !== 'owner' ? '공동편집 중에는 owner만 코멘트를 저장할 수 있습니다' : undefined}
                onClick={() => void addComment()}
              >
                {adding ? '저장 중…' : '코멘트 저장'}
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-0">
              {comments.length === 0 && (
                <p className="text-xs text-muted-foreground px-1">코멘트 없음</p>
              )}
              {comments.map((c, i) => (
                <div
                  key={`${c.cid || i}`}
                  className="rounded-md border border-border/60 p-2"
                >
                  <button
                    type="button"
                    onClick={() => openComment(c)}
                    className="w-full text-left"
                    title={`${c.slideNo}번 슬라이드로 이동`}
                  >
                    <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      <span className="shrink-0 font-mono">슬라이드 {c.slideNo}</span>
                      {c.resolved && <span className="shrink-0">· 해결됨</span>}
                    </div>
                    <div className="text-xs font-medium mt-0.5">{c.author}</div>
                    {editingId === c.cid ? (
                      <span className="block mt-0.5" onClick={(e) => e.stopPropagation()}>
                        <textarea
                          value={editDraft}
                          onChange={(e) => setEditDraft(e.target.value)}
                          rows={2}
                          className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs outline-none resize-none"
                        />
                      </span>
                    ) : (
                      <div className="text-xs whitespace-pre-wrap break-words mt-0.5">{c.text}</div>
                    )}
                  </button>
                  {c.replies.map((r, j) => (
                    <div key={j} className="mt-1.5 pl-2 border-l-2 border-border">
                      <div className="text-xs font-medium">{r.author}</div>
                      {editingId === r.cid ? (
                        <span className="block mt-0.5">
                          <textarea
                            value={editDraft}
                            onChange={(e) => setEditDraft(e.target.value)}
                            rows={2}
                            className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs outline-none resize-none"
                          />
                        </span>
                      ) : (
                        <div className="text-xs whitespace-pre-wrap break-words">{r.text}</div>
                      )}
                      <div className="flex items-center gap-0.5 mt-1">
                        <IconBtn
                          title="수정"
                          onClick={() => {
                            setEditingId(r.cid)
                            setEditDraft(r.text)
                            setReplyTo(null)
                            setDeleteArm(null)
                          }}
                        >
                          <Pencil className="w-3 h-3" />
                        </IconBtn>
                        <IconBtn
                          title={r.resolved ? '미해결로' : '해결됨으로'}
                          onClick={() => void toggleResolveReply(c, r)}
                        >
                          {r.resolved ? <RotateCcw className="w-3 h-3" /> : <Check className="w-3 h-3" />}
                        </IconBtn>
                        <IconBtn
                          title={deleteArm === r.cid ? '확인: 삭제' : '삭제'}
                          danger={deleteArm === r.cid}
                          onClick={() => void doDeleteReply(r)}
                        >
                          {deleteArm === r.cid ? <Check className="w-3 h-3" /> : <Trash2 className="w-3 h-3" />}
                        </IconBtn>
                        {editingId === r.cid && (
                          <>
                            <IconBtn
                              title="저장"
                              onClick={() => void saveReplyEdit(r)}
                            >
                              <Check className="w-3 h-3" />
                            </IconBtn>
                            <IconBtn title="취소" onClick={() => setEditingId(null)}>
                              <X className="w-3 h-3" />
                            </IconBtn>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                  {replyTo === c.cid && (
                    <div className="mt-1.5 space-y-1" onClick={(e) => e.stopPropagation()}>
                      <textarea
                        value={replyDraft}
                        onChange={(e) => setReplyDraft(e.target.value)}
                        placeholder="답글 입력"
                        rows={2}
                        className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs outline-none resize-none"
                      />
                      <div className="flex items-center gap-1">
                        <Button
                          size="sm"
                          className="h-6 text-[11px] flex-1"
                          disabled={!replyDraft.trim() || !!busyId}
                          onClick={() => void sendReply(c)}
                        >
                          답글 저장
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 text-[11px]"
                          onClick={() => {
                            setReplyTo(null)
                            setReplyDraft('')
                          }}
                        >
                          취소
                        </Button>
                      </div>
                    </div>
                  )}
                  {editingId === c.cid && (
                    <div className="flex items-center gap-1 mt-1.5" onClick={(e) => e.stopPropagation()}>
                      <Button
                        size="sm"
                        className="h-6 text-[11px] flex-1"
                        disabled={!editDraft.trim() || !!busyId}
                        onClick={() => void saveEdit(c)}
                      >
                        저장
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 text-[11px]"
                        onClick={() => setEditingId(null)}
                      >
                        취소
                      </Button>
                    </div>
                  )}
                  <div className="flex items-center gap-0.5 mt-1.5">
                    <IconBtn
                      title="답글"
                      onClick={() => {
                        setReplyTo(replyTo === c.cid ? null : c.cid)
                        setReplyDraft('')
                        setEditingId(null)
                        setDeleteArm(null)
                      }}
                    >
                      <Reply className="w-3 h-3" />
                    </IconBtn>
                    <IconBtn
                      title="수정"
                      onClick={() => {
                        setEditingId(c.cid)
                        setEditDraft(c.text)
                        setReplyTo(null)
                        setDeleteArm(null)
                      }}
                    >
                      <Pencil className="w-3 h-3" />
                    </IconBtn>
                    {c.format === 'modern' && (
                      <IconBtn
                        title={c.resolved ? '미해결로' : '해결됨으로'}
                        onClick={() => void toggleResolve(c)}
                      >
                        {c.resolved ? <RotateCcw className="w-3 h-3" /> : <Check className="w-3 h-3" />}
                      </IconBtn>
                    )}
                    <IconBtn
                      title={deleteArm === c.cid ? '확인: 삭제' : '삭제'}
                      danger={deleteArm === c.cid}
                      onClick={() => void doDelete(c)}
                    >
                      {deleteArm === c.cid ? <Check className="w-3 h-3" /> : <Trash2 className="w-3 h-3" />}
                    </IconBtn>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function IconBtn({
  title,
  danger,
  onClick,
  children,
}: {
  title: string
  danger?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={`inline-flex items-center justify-center h-6 w-6 rounded hover:bg-muted ${
        danger ? 'text-destructive' : 'text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
    </button>
  )
}
