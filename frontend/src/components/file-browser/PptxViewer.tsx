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
import { addPptxComment, replyPptxComment, setPptxCommentDone, editPptxComment, deletePptxComment } from './pptxCommentWriter'
import { collabApi, collabServerUrl, type ImageLossDetail } from '@/api/collab'
import { YCollabSession, buildCollaborationConfig, COLLAB_PALETTE, formatWhere } from '@/lib/ycollab'
import { useCollabUser } from '@/lib/collabUser'
import { activityLabel, peerActivity, usePeers, type Peer } from '@/lib/usePeers'
import { useMobile } from '@/hooks/useMobile'
import { useTheme } from '@/hooks/useTheme'
import { pptxThemeColors } from './viewerTheme'
import { countPptxDocImages, ensurePptxImagesSyncable } from '@/lib/pptxImageSync'
import { createSlideGate } from '@/lib/slideLocationGate'
import { acquireCollabSession, collabSessionCount, releaseCollabSession } from '@/lib/collabSessionRegistry'

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
  <div className="flex items-center justify-center py-12">
    <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
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

export default function PptxViewer({ data, fileName, editing, savePath, onFail }: { data: ArrayBuffer; fileName?: string; editing: boolean; savePath?: string; onFail: () => void }) {
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
      if (h) slideGateRef.current?.disarm()
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
  const collabRef = useRef<typeof collab>(null)
  collabRef.current = collab
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
  const saveCountRef = useRef(0)
  const save409Ref = useRef(0)
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
        curSlide,
        curSlideHistory: [...curSlideHistoryRef.current],
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
        return false
      }
      const res = await collabApi.save(c.roomId, c.session.clientId, bytes, baseHashRef.current, opts?.allowImageLoss ?? false)
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
  }, [fileName, savePath, updateDebug])
  const persistBytesRef = useRef(persistBytes)
  persistBytesRef.current = persistBytes

  // owner write-back (lib이 변경 debounce 후 호출). 서버 owner일 때만 저장한다.
  // lib role과 서버 owner가 어긋나도 409가 나지 않게 meta 기준으로 걸러 낸다.
  const handleWriteBack = useCallback(async (bytes: Uint8Array) => {
    const c = collabRef.current
    if (!c || !isOwnerNow(c)) return
    if (!c.session.synced) return
    let slides = 0
    try {
      slides = c.session.doc.getArray('pptx:slides').length
    } catch {
      slides = 0
    }
    if (slides === 0) return
    await persistBytes(bytes)
  }, [persistBytes, isOwnerNow])

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
      setSaving(true)
      void h
        .getContent()
        .then(async (bytes) => {
          // 수동 저장 경로라 배너/토스트를 막지 않는다 (R3).
          const fresh = new Uint8Array(bytes)
          const ok = await persistBytes(fresh, { quiet: true, auto: false })
          if (!ok) throw new Error('Save rejected')
          const cs = await loadPptxComments(fresh)
          setComments(cs)
        })
        .then(() => {
          showToast.success('저장했습니다')
          window.dispatchEvent(new CustomEvent('officeSaveDone', { detail: { ok: true } }))
        })
        .catch((e) => {
          showToast.error(e instanceof Error ? e.message : '저장 실패')
          window.dispatchEvent(new CustomEvent('officeSaveDone', { detail: { ok: false } }))
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
    let dead = false
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
        const { session, reused } = acquireCollabSession(
          savePath,
          () =>
            new YCollabSession(
              `${collabServerUrl()}/${info.roomId}`,
              { name: userNow.name, color: userNow.color },
              { mode: freshEditing ? 'edit' : 'view', userId: userNow.id, device: narrowViewport ? 'mobile' : 'desktop' },
            ),
          (created) => {
            created.knownHash = info.lastHash
            wireSessionRecovery(created)
            created.connect()
          },
        )
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
      if (!c) return
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
          releaseCollabSession(savePath, (s) => s.destroy())
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
  }, [savePath, collabUser, renameSessionKey])

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
        writeBackHaltedRef.current = false
        lossPendingRef.current = null
        setImageLoss(null)
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
  // edit↔view 전환·reloadKey bump·4001 재생성(모두 viewerKey에 포함)이 key를 바꾸며,
  // `editing`은 외부 prop이라 "바꾸기 직전"에 실행할 코드를 소유할 수 없다.
  // React의 "props 변경 시 state 보정" 패턴으로, 자식 렌더 **이전**에 값을 고정한다.
  const [prevViewerKey, setPrevViewerKey] = useState(viewerKey)
  if (prevViewerKey !== viewerKey) {
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
          btn.querySelectorAll('[data-collab-slide-dot]').forEach((d) => d.remove())
          if (list.length === 0) return
          const html = btn as HTMLElement
          try {
            if (window.getComputedStyle(html).position === 'static') html.style.position = 'relative'
          } catch {
            // 무시
          }
          list.slice(0, 3).forEach((p, i) => {
            const dot = document.createElement('span')
            dot.setAttribute('data-collab-slide-dot', p.id)
            dot.title = p.name
            const recent = p.lastEditAt != null && Date.now() - p.lastEditAt < 3000
            dot.className = recent ? 'animate-pulse' : ''
            dot.setAttribute(
              'style',
              `display:inline-block;width:8px;height:8px;border-radius:9999px;background:${p.color};` +
                `position:absolute;right:${2 + i * 10}px;top:2px;border:1px solid #fff;z-index:5;` +
                (recent ? `box-shadow:0 0 0 2px ${p.color}55;` : ''),
            )
            html.appendChild(dot)
          })
          if (list.length > 3) {
            const more = document.createElement('span')
            more.setAttribute('data-collab-slide-dot', 'more')
            more.textContent = `+${list.length - 3}`
            more.setAttribute(
              'style',
              'position:absolute;right:2px;top:12px;font-size:9px;line-height:1;z-index:5;background:rgba(0,0,0,.55);color:#fff;border-radius:6px;padding:1px 3px;',
            )
            html.appendChild(more)
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
        <div data-testid="collab-presence-bar" className="flex items-center gap-2 px-3 py-1 border-b border-border text-[11px] text-muted-foreground overflow-x-auto">
          {(['view', 'edit'] as const).map((mode, gi) => {
            const group = peers.filter((p) => p.mode === mode && !p.isSelf)
            return (
              <span key={mode} className="inline-flex items-center gap-1 shrink-0">
                {gi > 0 && <span className="mx-1">·</span>}
                <span className="font-medium">{mode === 'view' ? 'viewer' : 'editor'} -</span>
                {group.map((p) => {
                  const act = peerActivity(p, Date.now())
                  const status = act === 'idle' ? '' : activityLabel(p, Date.now())
                  return (
                    <button
                      key={p.id}
                      type="button"
                      data-testid="collab-peer"
                      data-peer-id={p.id}
                      data-mode={p.mode}
                      {...(typeof p.slide === 'number' ? { 'data-slide': p.slide } : {})}
                      data-owner={p.isOwner ? 'true' : 'false'}
                      data-self="false"
                      data-activity={act}
                      data-following={followId === p.id ? 'true' : 'false'}
                      {...(p.selectedLabel ? { 'data-selected-label': p.selectedLabel } : {})}
                      title={followId === p.id ? `${p.name} 팔로우 중 (클릭하면 해제)` : `${p.name} 팔로우`}
                      aria-pressed={followId === p.id}
                      onClick={() => {
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
                      className={`inline-flex items-center gap-1 shrink-0 hover:text-foreground${
                        followId === p.id ? ' underline decoration-dotted underline-offset-2' : ''
                      }`}
                    >
                      <span
                        className={`inline-block w-2 h-2 rounded-full${act === 'editing' ? ' animate-pulse' : ''}`}
                        style={act === 'editing' ? { backgroundColor: p.color } : { border: `1.5px solid ${p.color}` }}
                      />
<span>
                        {p.name}
                        {p.tabCount > 1 ? ` (${p.tabCount}탭)` : ''}
                        {p.device === 'mobile' ? '📱' : ''}
                        {/* 표시 위치 규칙: where 우선, 없으면 slide에서 ("슬라이드 N"), 둘 다 없으면 생략.
                        구버전 클라이언트는 where를 게시하지 않으므로 slide fallback이 필요하다.
                        텍스트 노드로만 렌더한다(HTML 삽입 없음). */}
                        {p.where ?? (typeof p.slide === 'number' ? `슬라이드 ${p.slide}` : '')}
                        {p.where || typeof p.slide === 'number' ? ' · ' : ''}
                        {status ? ` · ${status}` : ''}
                      </span>
                    </button>
                  )
                })}
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
                <span
                  data-testid="collab-peer"
                  data-peer-id={self.id}
                  data-mode={self.mode}
                  data-owner={self.isOwner ? 'true' : 'false'}
                  data-self="true"
                  data-activity={peerActivity(self, Date.now())}
                  className="hidden"
                />
              </span>
            )
          })()}
        </div>
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
                  theme={viewerTheme}
                  initialSlide={slideIdx}
                  // Y2: arm 신호. deps가 [slides.length]라 parse 전 0으로도 호출되므로
                  // count > 0일 때만 "덱이 다 파싱됐다"고 본다
                  // (chunk-552NAFTD.js:11284-11286).
                  onSlideCountChange={(count: number) => {
                    if (count > 0) slideGateRef.current?.arm()
                  }}
                  onActiveSlideChange={(i: number) => {
                    // W1: 게이트 모듈이 cur 반영(즉시)과 게시(0은 300ms 지연)를 함께 처리한다.
                    // Y2: arm 전에는 이 호출이 전부 무시된다.
                    slideGateRef.current?.onIndex(i)
                  }}
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
