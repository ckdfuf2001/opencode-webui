import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Loader2, RefreshCw, Reply, Pencil, Check, RotateCcw, Trash2, X } from 'lucide-react'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { translationsEn } from 'pptx-react-viewer/i18n'
import 'pptx-react-viewer/styles.css'
import { Button } from '@/components/ui/button'
import { saveOfficeBytes } from './officeSave'
import { showToast } from '@/lib/toast'
import { PptxViewerBoundary } from './ViewerBoundaries'
import { PowerPointViewer } from 'pptx-react-viewer'
import { loadPptxComments, type PptxComment } from './pptxComments'
import { addPptxComment, replyPptxComment, setPptxCommentDone, editPptxComment, deletePptxComment } from './pptxCommentWriter'
import { collabApi, collabServerUrl, type CollabParticipant } from '@/api/collab'
import { YCollabSession, buildCollaborationConfig, colorForName } from '@/lib/ycollab'
import { useMobile } from '@/hooks/useMobile'
import { useTheme } from '@/hooks/useTheme'
import { pptxThemeColors } from './viewerTheme'

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

export interface CollabIdentity {
  id: string
  name: string
  color: string
}

/** localStorage collab-user (E2E는 addInitScript로 주입). 없으면 이름 모달. */
export function readCollabUser(): CollabIdentity | null {
  try {
    const raw = localStorage.getItem('collab-user')
    if (!raw) return null
    const p = JSON.parse(raw) as { id?: unknown; name?: unknown; color?: unknown }
    if (typeof p?.id !== 'string' || !p.id || typeof p?.name !== 'string' || !p.name.trim()) return null
    const name = p.name.trim()
    return {
      id: p.id,
      name,
      color: typeof p.color === 'string' && p.color ? p.color : colorForName(name),
    }
  } catch {
    return null
  }
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
  const viewerRef = useRef<{ getContent: () => Promise<Uint8Array> } | null>(null)
  const setViewerRef = useCallback(
    (h: { getContent: () => Promise<Uint8Array> } | null) => {
      viewerRef.current = h
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
  const onViewerContentChange = useCallback(async () => {
    await refreshComments()
  }, [refreshComments])
  const [comments, setComments] = useState<PptxComment[]>([])
  const [showComments, setShowComments] = useState(false)
  const [slideIdx, setSlideIdx] = useState(0)
  const [curSlide, setCurSlide] = useState(0)
  const [reloadKey, setReloadKey] = useState(0)
  const [author, setAuthor] = useState(() => {
    try {
      return localStorage.getItem('ppt-comment-author') ?? ''
    } catch {
      return ''
    }
  })
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState(false)
  // 공동편집 (파일 열림부터 세션 참가 — 보기 모드는 view로, AI 차단을 걸지 않는다).
  const [collab, setCollab] = useState<{
    session: YCollabSession
    roomId: string
    epoch: string
    role: 'owner' | 'collaborator' | 'viewer'
    editRole: 'owner' | 'collaborator'
    intent: 'create' | 'join'
    userId: string
  } | null>(null)
  const [participants, setParticipants] = useState<CollabParticipant[]>([])
  const participantsRef = useRef<CollabParticipant[]>([])
  participantsRef.current = participants
  // E8: collab-user 없으면 이름 모달이 막는다.
  const [needName, setNeedName] = useState(false)
  const [nameInput, setNameInput] = useState('')
  const [nameTick, setNameTick] = useState(0)
  // E10: AI-blocked 칩 (서버 aiBlockedAt 래치 + 30초 클라이언트 만료).
  const [aiBlocked, setAiBlocked] = useState(false)
  const aiBlockRef = useRef<number | null>(null)
  const aiShownAtRef = useRef(0)
  const [collabKey, setCollabKey] = useState(0)
  const [collabNotice, setCollabNotice] = useState<string | null>(null)
  const [mineFile, setMineFile] = useState<{ url: string; name: string } | null>(null)
  const [connBadge, setConnBadge] = useState<{ status: string; synced: boolean }>({ status: 'connecting', synced: false })
  const baseHashRef = useRef<string | null>(null)
  const collabRef = useRef<typeof collab>(null)
  collabRef.current = collab
  const editingRef = useRef(editing)
  editingRef.current = editing
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
        role: c?.role ?? null,
        synced: c?.session.synced ?? false,
        ownerClientId: ownerIdRef.current,
        clientId: c?.session.clientId ?? 0,
        lastSave: lastSaveRef.current,
        saveCount: saveCountRef.current,
        save409Count: save409Ref.current,
        slideCountY,
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

  // 저장 일원화: collab 중이면 owner save API, 아니면 직접 저장.
  // 판정은 서버 lastHash 기준. 실패는 절대 조용히 넘기지 않는다.
  const persistBytes = useCallback(async (bytes: Uint8Array): Promise<boolean> => {
    const c = collabRef.current
    if (c && savePath) {
      const res = await collabApi.save(c.roomId, c.session.clientId, bytes, baseHashRef.current)
      // E2E 디버그: 저장 결과 기록 (200/409 추적용).
      saveCountRef.current += 1
      if (res.ok) {
        lastSaveRef.current = { at: Date.now(), status: 200 }
      } else if (res.reason === 'conflict' || res.reason === 'denied') {
        lastSaveRef.current = { at: Date.now(), status: 409 }
        save409Ref.current += 1
      } else {
        lastSaveRef.current = { at: Date.now(), status: 0 }
      }
      updateDebug()
      if (res.ok) {
        baseHashRef.current = res.newHash
        c.session.knownHash = res.newHash
        setSavedBytes(new Uint8Array(bytes))
        return true
      }
      if (res.reason === 'conflict') {
        setCollabNotice('외부에서 변경됨 — 다시 열기 (자동 병합 없음).')
      } else if (res.reason === 'not_seeded') {
        setCollabNotice('아직 동기화 전입니다. 잠시 후 다시 저장하세요.')
      } else {
        setCollabNotice(res.message ?? 'Save denied (not owner).')
      }
      showToast.error(res.message ?? 'Save failed')
      return false
    }
    if (!savePath) return false
    await saveOfficeBytes(
      savePath,
      fileName ?? 'presentation.pptx',
      new Blob([bytes as unknown as BlobPart], {
        type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      }),
    )
    setSavedBytes(new Uint8Array(bytes))
    return true
  }, [fileName, savePath, updateDebug])

  // owner write-back (lib이 변경 debounce 후 호출). synced 전에는 저장하지 않는다.
  const handleWriteBack = useCallback(async (bytes: Uint8Array) => {
    const c = collabRef.current
    if (!c || c.role !== 'owner') return
    if (!c.session.synced) return
    await persistBytes(bytes)
  }, [persistBytes])

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
          // collab 저장 경로로 일원화 (baseHash 검사). solo면 직접 저장.
          const fresh = new Uint8Array(bytes)
          const ok = await persistBytes(fresh)
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

  // 세션 생명주기: 파일 열림 ~ 닫힘. 보기 모드도 view로 참가한다 (AI 차단 없음).
  // 편집 진입/종료는 아래 모드 전환 effect가 처리한다. 실패하면 solo로 폴백.
  // E8: collab-user 없으면 이름 모달이 막고, 입력 전까지 연결하지 않는다.
  useEffect(() => {
    if (!savePath) return
    let dead = false
    const user = readCollabUser()
    if (!user) {
      setNeedName(true)
      return
    }
    setNeedName(false)
    const startEditing = editingRef.current
    void (async () => {
      try {
        const info = await collabApi.session(savePath)
        if (dead) return
        const session = new YCollabSession(`${collabServerUrl()}/${info.roomId}`, {
          name: user.name,
          color: user.color,
        }, { mode: startEditing ? 'edit' : 'view', userId: user.id })
        session.knownHash = info.lastHash
        wireSessionRecovery(session)
        session.connect()
        baseHashRef.current = info.lastHash
        setCollabNotice(null)
        setMineFile(null)
        toastedStatus.current = null
        const editRole = info.role === 'host' ? 'owner' : 'collaborator'
        setCollab({
          session,
          roomId: info.roomId,
          epoch: info.epoch,
          role: startEditing ? editRole : 'viewer',
          editRole,
          intent: info.role === 'host' ? 'create' : 'join',
          userId: user.id,
        })
        updateDebug()
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
          if (c.role === 'owner' && c.session.synced) {
            const h = viewerRef.current
            if (h) await persistBytes(new Uint8Array(await h.getContent()))
          }
        } catch {
          // 무시
        } finally {
          c.session.destroy()
          setParticipants([])
          aiBlockRef.current = null
          setAiBlocked(false)
          ownerIdRef.current = null
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
  }, [savePath, nameTick])

  // E8: 이름 제출 — 저장 후 세션 생성 재시도.
  const submitName = useCallback(() => {
    const name = nameInput.trim()
    if (!name) return
    const user: CollabIdentity = {
      id: `u-${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`,
      name,
      color: colorForName(name),
    }
    try {
      localStorage.setItem('collab-user', JSON.stringify(user))
    } catch {
      // 무시
    }
    setNeedName(false)
    setNameInput('')
    setNameTick((v) => v + 1)
  }, [nameInput])

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

  // 편집 진입/종료에 맞춰 세션 모드 전환 (세션·doc 유지, viewer만 리마운트).
  useEffect(() => {
    const c = collabRef.current
    if (!c || !savePath) return
    if (editing && c.role === 'viewer') {
      c.session.setMode('edit')
      if (collabRef.current === c) {
        setCollab({ ...c, role: c.editRole })
        setCollabKey((v) => v + 1)
      }
    } else if (!editing && c.role !== 'viewer') {
      void (async () => {
        try {
          if (c.role === 'owner' && c.session.synced) {
            const h = viewerRef.current
            if (h) await persistBytes(new Uint8Array(await h.getContent()))
          }
        } catch {
          // 무시
        } finally {
          if (collabRef.current !== c) return
          c.session.setMode('view')
          setCollab({ ...c, role: 'viewer' })
          setCollabKey((v) => v + 1)
        }
      })()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, savePath])

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
    // 연결 상태 배지 + 전이 토스트(각 한 번).
    session.subscribe(() => {
      const snap = session.getSnapshot()
      setConnBadge({ status: snap.status, synced: snap.synced })
      updateDebug()
      if (snap.status === 'disconnected' && toastedStatus.current !== 'disconnected') {
        toastedStatus.current = 'disconnected'
        showToast.warning('연결이 끊김 — 재연결 중')
      } else if (snap.status === 'connected' && toastedStatus.current === 'disconnected') {
        toastedStatus.current = 'connected'
        showToast.success('다시 연결됨')
      } else if (snap.status === 'error' && toastedStatus.current !== 'error') {
        toastedStatus.current = 'error'
        showToast.error('공동편집 오류')
      }
    })
    // Y 슬라이드 수 추적 (doc은 세션 동안 유지되므로 여기서 1회만).
    const onDocUpdate = (): void => updateDebug()
    try {
      session.doc.on('update', onDocUpdate)
    } catch {
      // 무시
    }
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
          // view-only room이어도 참가자바는 갱신한다.
          if (lock) {
            setParticipants(lock.participants ?? [])
            trackAiBlocked(lock.aiBlockedAt ?? null)
          }
          updateDebug()
          return // 재연결 루프가 resume 처리
        }
        setParticipants(lock.participants ?? [])
        trackAiBlocked(lock.aiBlockedAt ?? null)
        ownerIdRef.current = (lock.owner ?? [])[0] ?? null
        updateDebug()
        if (lock.lastHash) {
          baseHashRef.current = lock.lastHash
          c.session.knownHash = lock.lastHash
        }
        if (lock.externalChanged) {
          setCollabNotice('외부에서 변경됨 — 다시 열기 (자동 병합 없음).')
        }
        const me = c.session.clientId
        const amOwner = (lock.owner ?? []).includes(me)
        // 보기 모드에선 role을 건드리지 않는다 (전환 effect 전담).
        if (!editingRef.current) return
        if (amOwner && c.role !== 'owner') {
          // 승계됨: 즉시 flush 후 role 반영(리마운트).
          try {
            const h = viewerRef.current
            if (h && c.session.synced) await persistBytes(new Uint8Array(await h.getContent()))
          } catch {
            // 무시
          }
          if (collabRef.current === c) {
            setCollab({ ...c, role: 'owner' })
            setCollabKey((v) => v + 1)
          }
        } else if (!amOwner && c.role !== 'collaborator') {
          if (collabRef.current === c) {
            setCollab({ ...c, role: 'collaborator' })
            setCollabKey((v) => v + 1)
          }
        }
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
        if (c && c.role === 'owner' && c.session.synced) {
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
  }, [data])
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
  }
  const addComment = async () => {
    const text = draft.trim()
    if (!text || adding) return
    if (!savePath) {
      showToast.error('저장 경로가 없습니다')
      return
    }
    // 작성자 통일을 위해 lib 기본값('You')과 맞춘다. 파일에 작성자가 1명이면 그걸 쓴다.
    const existingAuthors = [...new Set(comments.map((c) => c.author).filter((a) => a && a !== 'Unknown'))]
    const name = author.trim() || (existingAuthors.length === 1 ? existingAuthors[0] : 'You')
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
      let base = content
      if (editing) {
        const h = viewerRef.current
        if (!h) return false
        const cur = new Uint8Array(await h.getContent())
        if (!(await persistBytes(cur))) return false
        base = cur
      }
      const next = await op(base)
      if (!(await persistBytes(new Uint8Array(next)))) return false
      setSavedBytes(next)
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
      const name = author.trim() || (existingAuthors.length === 1 ? existingAuthors[0] : 'You')
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
  // 공동편집 설정 (세션 성공 때만 — 편집은 owner/collaborator, 보기는 viewer). 실패하면 solo(기존 동작).
  // P0-4: 모든 hook은 early return보다 위에 있어야 한다 (React #300).
  // 복호화한 바이트를 디스크에 그대로 쓸 수 있어 암호 문서는 공동편집 제외.
  const authorName = author.trim() || 'You'
  const isDecrypted = unlocked !== null
  const collaboration = useMemo(
    () =>
      buildCollaborationConfig(collab, {
        editing,
        viewing: !editing,
        authorName,
        isDecrypted,
        writeBackDebounceMs: 2500,
        onWriteBack: (bytes: Uint8Array) => {
          void handleWriteBack(bytes)
        },
      }),
    [collab, editing, authorName, isDecrypted, handleWriteBack],
  )
  const viewerRootRef = useRef<HTMLDivElement | null>(null)

  // E2E: PowerPointViewer 마운트 횟수 (?collabDebug=1일 때만).
  // viewer key가 바뀌면 리마운트되므로 key 문자열을 deps로 둔다.
  const viewerKey = `${editing ? 'edit' : 'view'}#${slideIdx}#${reloadKey}#${collab ? `${collab.role}-${collabKey}` : 'solo'}`
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
        const byColor = participantsRef.current.find((p) => p.color.toLowerCase() === hex)
        if (byColor) {
          peerId = byColor.id
        } else {
          const label = el.querySelector('span')?.textContent?.trim() ?? ''
          const byName = label
            ? participantsRef.current.find((p) => p.name === label)
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
  }, [collab, participants])

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
      {needName && (
        <div data-testid="collab-name-modal" className="px-3 py-2 border-b border-border bg-background">
          <p className="text-xs font-medium mb-1.5">Enter your name to join co-editing</p>
          <div className="flex items-center gap-2">
            <input
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submitName() }}
              placeholder="Name"
              className="h-8 w-56 rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            />
            <Button size="sm" data-testid="collab-name-submit" onClick={submitName}>
              Join
            </Button>
          </div>
        </div>
      )}
      {collab && (
        <div
          data-testid="collab-status"
          data-status={!online ? 'offline' : connBadge.status === 'disconnected' ? 'reconnecting' : connBadge.status}
          className="flex items-center gap-1.5 px-3 py-1 border-b border-border text-[11px] text-muted-foreground"
        >
          <span
            className={`inline-block w-1.5 h-1.5 rounded-full ${
              connBadge.status === 'connected'
                ? 'bg-green-500'
                : connBadge.status === 'error'
                  ? 'bg-red-500'
                  : 'bg-amber-500 animate-pulse'
            }`}
          />
          <span>
            {connBadge.status === 'connected'
              ? `연결됨 (${collab.role})`
              : connBadge.status === 'error'
                ? '오류'
                : connBadge.status === 'disconnected'
                  ? '재연결 중'
                  : '연결 중'}
          </span>
        </div>
      )}
      {collab && participants.length > 0 && (
        <div data-testid="collab-presence-bar" className="flex items-center gap-2 px-3 py-1 border-b border-border text-[11px] text-muted-foreground overflow-x-auto">
          {participants.map((p) => (
            <span
              key={p.id}
              data-testid="collab-peer"
              data-peer-id={p.id}
              data-mode={p.mode}
              {...(typeof p.slide === 'number' ? { 'data-slide': p.slide } : {})}
              data-owner={p.owner ? 'true' : 'false'}
              data-self={p.id === collab.userId ? 'true' : 'false'}
              className="inline-flex items-center gap-1 shrink-0"
            >
              <span
                className="inline-block w-2 h-2 rounded-full"
                style={{ backgroundColor: p.color }}
              />
              <span>
                {p.name}
                {p.mode === 'edit' ? ' · 편집 중' : ''}
                {typeof p.slide === 'number' ? ` · slide ${p.slide}` : ''}
                {p.mode === 'view' ? ' · view-only' : ''}
              </span>
            </span>
          ))}
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
                  onActiveSlideChange={(i: number) => setCurSlide(i)}
                  onContentChange={() => void onViewerContentChange()}
                  collaboration={collaboration}
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
