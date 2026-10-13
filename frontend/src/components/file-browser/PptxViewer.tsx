import { Component, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Loader2, RefreshCw, Reply, Pencil, Check, RotateCcw, Trash2, X } from 'lucide-react'
import { createInstance } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { translationsEn } from 'pptx-react-viewer/i18n'
import 'pptx-react-viewer/styles.css'
import { Button } from '@/components/ui/button'
import { saveOfficeBytes } from './officeSave'
import { showToast } from '@/lib/toast'
import { lazyWithRetry } from './lazyRetry'
import { loadPptxComments, type PptxComment } from './pptxComments'
import { addPptxComment, replyPptxComment, setPptxCommentDone, editPptxComment, deletePptxComment } from './pptxCommentWriter'
import { collabApi, collabServerUrl } from '@/api/collab'
import { YCollabSession, colorForName } from '@/lib/ycollab'
import type { CollaborationConfig } from 'pptx-react-viewer'

const PowerPointViewer = lazyWithRetry(() =>
  import('pptx-react-viewer').then((m) => ({ default: m.PowerPointViewer })),
)

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

export default function PptxViewer({ data, fileName, editing, savePath, onFail }: { data: ArrayBuffer; fileName?: string; editing: boolean; savePath?: string; onFail: () => void }) {
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
  useEffect(() => {
    const onSave = () => {
      if (saving) return
      const h = viewerRef.current
      if (!h || !savePath) return
      setSaving(true)
      void h
        .getContent()
        .then(async (bytes) => {
          await saveOfficeBytes(
            savePath,
            fileName ?? 'presentation.pptx',
            new Blob([bytes as unknown as BlobPart], {
              type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            }),
          )
          // 저장된 바이트로 기준을 갱신한다 — 안 그러면 다음 코멘트 추가가 이전 내용을 덮는다.
          const fresh = new Uint8Array(bytes)
          setSavedBytes(fresh)
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
  }, [savePath, fileName, saving])
  // lib에서 코멘트 추가 등 모델이 바뀌면 우리 목록도 다시 읽는다 (저장 전에도 보인다).
  const refreshComments = useCallback(async () => {
    const h = viewerRef.current
    if (!h) return
    try {
      const bytes = await h.getContent()
      const cs = await loadPptxComments(new Uint8Array(bytes))
      setComments(cs)
      if (cs.length > 0) setShowComments(true)
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
  // 공동편집 (편집 모드에서만 세션 참가 — 보기만 할 때는 AI 차단을 걸지 않는다).
  const [collab, setCollab] = useState<{
    session: YCollabSession
    roomId: string
    role: 'owner' | 'collaborator'
  } | null>(null)
  const [collabKey, setCollabKey] = useState(0)
  const [collabNotice, setCollabNotice] = useState<string | null>(null)
  const baseHashRef = useRef<string | null>(null)
  const collabRef = useRef<typeof collab>(null)
  collabRef.current = collab

  // 저장 일원화: collab 중이면 owner save API(baseHash 검사), 아니면 직접 저장.
  const persistBytes = useCallback(async (bytes: Uint8Array): Promise<boolean> => {
    const c = collabRef.current
    if (c && savePath) {
      const res = await collabApi.save(c.roomId, c.session.clientId, baseHashRef.current ?? '', bytes)
      if (res.ok) {
        baseHashRef.current = res.newHash
        setSavedBytes(new Uint8Array(bytes))
        return true
      }
      if (res.reason === 'conflict') {
        setCollabNotice('Changed elsewhere — close and reopen to resync (no auto-merge).')
      } else {
        setCollabNotice(res.message ?? 'Save denied (not owner).')
      }
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
  }, [fileName, savePath])

  // owner write-back (lib이 변경 debounce 후 호출).
  const handleWriteBack = useCallback(async (bytes: Uint8Array) => {
    const c = collabRef.current
    if (!c || c.role !== 'owner') return
    await persistBytes(bytes)
  }, [persistBytes])

  // 편집 진입/종료에 맞춰 collab 세션 생명주기 관리. 실패하면 solo로 폴백.
  useEffect(() => {
    if (!editing || !savePath) return
    let dead = false
    const name = author.trim() || 'You'
    void (async () => {
      try {
        const info = await collabApi.session(savePath)
        if (dead) return
        const session = new YCollabSession(`${collabServerUrl()}/${info.roomId}`, {
          name,
          color: colorForName(name),
        })
        session.connect()
        baseHashRef.current = info.fileHash
        setCollabNotice(null)
        setCollab({ session, roomId: info.roomId, role: info.role === 'host' ? 'owner' : 'collaborator' })
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
          if (c.role === 'owner') {
            const h = viewerRef.current
            if (h) await persistBytes(new Uint8Array(await h.getContent()))
          }
        } catch {
          // 무시
        } finally {
          c.session.destroy()
          if (collabRef.current === c) {
            collabRef.current = null
            setCollab(null)
            baseHashRef.current = null
          }
        }
      })()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, savePath])

  // owner 승계 감지 + 외부변경 배너 (5초 폴).
  useEffect(() => {
    if (!collab || !savePath) return
    const id = setInterval(() => {
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
          // room 소멸(백엔드 재시작 등) → solo로 복귀.
          c.session.destroy()
          collabRef.current = null
          setCollab(null)
          baseHashRef.current = null
          setCollabNotice(null)
          return
        }
        if (lock.externalChanged) {
          setCollabNotice('Changed elsewhere — close and reopen to resync (no auto-merge).')
        }
        const me = c.session.clientId
        const amOwner = (lock.owner ?? []).includes(me)
        if (amOwner && c.role !== 'owner') {
          // 승계됨: 즉시 flush 후 role 반영(리마운트).
          try {
            const h = viewerRef.current
            if (h) await persistBytes(new Uint8Array(await h.getContent()))
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
    }, 5000)
    return () => clearInterval(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collab, savePath])
  useEffect(() => {
    setComments([])
    setShowComments(false)
    setSlideIdx(0)
    setCurSlide(0)
    setSavedBytes(null)
    setDraft('')
  }, [data])
  useEffect(() => {
    let dead = false
    void loadPptxComments(content).then((cs) => {
      if (dead) return
      setComments(cs)
      if (cs.length > 0) setShowComments(true)
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
      if (cs.length > 0) setShowComments(true)
      setReloadKey((v) => v + 1)
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
  // 공동편집 설정 (편집 모드 + 세션 성공 때만). 실패하면 solo(기존 동작).
  const authorName = author.trim() || 'You'
  const collaboration = useMemo((): CollaborationConfig | undefined => {
    if (!collab || !editing) return undefined
    return {
      roomId: collab.roomId,
      // externalSession을 쓰므로 무시된다.
      serverUrl: '',
      externalSession: collab.session.toExternal() as unknown as CollaborationConfig['externalSession'],
      userName: authorName,
      userColor: colorForName(authorName),
      role: collab.role,
      onWriteBack: (bytes: Uint8Array) => {
        void handleWriteBack(bytes)
      },
    }
  }, [collab, collabKey, editing, authorName, handleWriteBack])

  return (
    <div
      className={`relative h-full min-h-[480px]${editing ? '' : ' pptx-preview-compact'}`}
    >
      {collabNotice && (
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-amber-500/40 bg-amber-500/10 text-[11px] text-amber-600 dark:text-amber-400">
          <span className="flex-1">{collabNotice}</span>
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
                  key={`${editing ? 'edit' : 'view'}#${slideIdx}#${reloadKey}#${collab ? `${collab.role}-${collabKey}` : 'solo'}`}
                  ref={setViewerRef}
                  content={unlocked ?? content}
                  fileName={fileName}
                  canEdit={editing}
                  showToolbar={editing}
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
          <div data-pptx-comments className="absolute right-2 top-2 bottom-2 w-72 z-30 border border-border bg-background flex flex-col rounded-lg shadow-xl">
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
                disabled={!draft.trim() || adding}
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

class PptxViewerBoundary extends Component<{ onFail: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  componentDidCatch(): void {
    this.props.onFail()
  }
  render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}
