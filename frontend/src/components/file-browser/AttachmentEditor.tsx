import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { showToast } from '@/lib/toast'
import { readCollabUser } from '@/lib/collabUser'
import {
  acquireAttachmentLock,
  getAttachmentPart,
  putAttachmentPart,
  releaseAttachmentLock,
  type AttachmentOpenDetail,
  type AttachmentSaver,
} from './embedEdit'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ViewerLoadBoundary } from './ViewerBoundaries'
import { DocxViewer, XlsxViewer } from './DocumentPreview'
import PptxViewer from './PptxViewer'

const RENEW_MS = 20_000
const SAVE_WAIT_MS = 8000

function randomToken(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `t-${Date.now().toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`
  }
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** officeSaveDone 대기 (부모 저장 요청 후 1회 재시도용). */
function waitParentSaveDone(parentPath: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const timer = setTimeout(() => {
      if (!done) {
        done = true
        window.removeEventListener('officeSaveDone', onDone)
        resolve(false)
      }
    }, timeoutMs)
    const onDone = (e: Event): void => {
      const d = (e as CustomEvent<{ ok?: boolean; path?: string }>).detail
      if (d?.path !== undefined && d.path !== parentPath) return
      if (!done) {
        done = true
        clearTimeout(timer)
        window.removeEventListener('officeSaveDone', onDone)
        resolve(d?.ok === true)
      }
    }
    window.addEventListener('officeSaveDone', onDone)
    window.dispatchEvent(new CustomEvent('officeSaveRequest'))
  })
}

export default function AttachmentEditor({
  target,
  onClose,
}: {
  target: AttachmentOpenDetail
  onClose: () => void
}) {
  const { parentPath, parentName, part, name, kind, roomId, clientId } = target
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorText, setErrorText] = useState('')
  const [bytes, setBytes] = useState<Uint8Array | null>(null)
  const [, setBaseHash] = useState<string | undefined>(undefined)
  const [origPartHash, setOrigPartHash] = useState<string>('')
  const [readOnly, setReadOnly] = useState(false)
  const [, setLockHolder] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [gen, setGen] = useState(0)
  const [dirtyTick, setDirtyTick] = useState(0)
  const saverRef = useRef<AttachmentSaver | null>(null)
  const lockRef = useRef<{ lockId: string; token: string } | null>(null)
  const baseHashRef = useRef<string | undefined>(undefined)
  const origBytesRef = useRef<Uint8Array | null>(null)
  const mountedRef = useRef(true)
  const holderName = useMemo(() => readCollabUser()?.name?.trim() || 'user', [])
  const tokenRef = useRef<string | null>(null)
  if (!tokenRef.current) tokenRef.current = randomToken()

  // 열기: 바이트 수신 + 잠금 획득 (한 번만, 마운트 시).
  useEffect(() => {
    mountedRef.current = true
    let dead = false
    const token = tokenRef.current!
    void (async () => {
      try {
        const got = await getAttachmentPart(parentPath, part, { roomId, clientId })
        if (dead) return
        setBytes(got.bytes)
        setBaseHash(got.hash)
        baseHashRef.current = got.hash
        origBytesRef.current = got.bytes
        try {
          setOrigPartHash(await sha256Hex(got.bytes))
        } catch {
          setOrigPartHash('')
        }
      } catch (e) {
        if (dead) return
        const code = (e as { code?: string })?.code
        if (code === 'view_only') {
          showToast.error('보기 모드에서는 첨부를 열 수 없습니다')
          onClose()
          return
        }
        setErrorText(e instanceof Error ? e.message : '첨부를 불러오지 못했습니다')
        setPhase('error')
        return
      }
      try {
        const r = await acquireAttachmentLock(parentPath, part, holderName, token)
        if (dead) {
          await releaseAttachmentLock(parentPath, part, r.lockId, token).catch(() => {})
          return
        }
        lockRef.current = { lockId: r.lockId, token }
        setReadOnly(false)
        setLockHolder(null)
      } catch (e) {
        if (dead) return
        const code = (e as { code?: string })?.code
        if (code === 'locked') {
          const holder = (e as { holderName?: string }).holderName ?? '다른 사용자'
          setLockHolder(holder)
          setReadOnly(true)
          showToast.info(`${holder}님이 편집 중`)
        } else {
          setReadOnly(true)
          showToast.error(e instanceof Error ? e.message : '잠금을 얻지 못해 읽기 전용으로 엽니다')
        }
      } finally {
        if (!dead) setPhase('ready')
      }
    })()
    const renew = window.setInterval(() => {
      const l = lockRef.current
      if (!l || document.hidden) return
      void acquireAttachmentLock(parentPath, part, holderName, l.token, l.lockId).catch(() => {
        // 갱신 실패는 다음 틱에 다시 시도한다 (TTL 60s 안에는 3번 기회).
      })
    }, RENEW_MS)
    return () => {
      dead = true
      mountedRef.current = false
      window.clearInterval(renew)
      const l = lockRef.current
      lockRef.current = null
      if (l) void releaseAttachmentLock(parentPath, part, l.lockId, l.token).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 마운트 시 1회 오픈 플로우
  }, [])

  void dirtyTick

  const persist = useCallback(
    async (next: Uint8Array): Promise<boolean> => {
      const l = lockRef.current
      if (!l) {
        showToast.error('편집 잠금이 없습니다. 다시 열어 주세요')
        return false
      }
      const doPut = async (hash: string | undefined) => {
        const r = await putAttachmentPart(parentPath, part, next, {
          baseHash: hash,
          lockId: l.lockId,
          roomId,
          clientId,
          fileName: name,
        })
        return r
      }
      try {
        const r = await doPut(baseHashRef.current)
        if (r.ok) {
          if (r.newHash) {
            baseHashRef.current = r.newHash
            setBaseHash(r.newHash)
          }
          try {
            setOrigPartHash(await sha256Hex(next))
            origBytesRef.current = next
          } catch {
            /* 무시 */
          }
          showToast.success('저장했습니다')
          return true
        }
        if (r.code === 'stale') {
          // 방이 앞서감. 파트가 실제로 바뀌었는지 확인하고 같으면 base만 갱신해 1회 재시도.
          try {
            const fresh = await getAttachmentPart(parentPath, part, { roomId, clientId })
            let same = false
            try {
              same = (await sha256Hex(fresh.bytes)) === origPartHash
            } catch {
              same = false
            }
            if (same) {
              baseHashRef.current = fresh.hash
              setBaseHash(fresh.hash)
              const r2 = await doPut(fresh.hash)
              if (r2.ok) {
                if (r2.newHash) {
                  baseHashRef.current = r2.newHash
                  setBaseHash(r2.newHash)
                }
                try {
                  setOrigPartHash(await sha256Hex(next))
                  origBytesRef.current = next
                } catch {
                  /* 무시 */
                }
                showToast.success('저장했습니다')
                return true
              }
              showToast.error(r2.error ?? '저장에 실패했습니다')
              return false
            }
          } catch {
            /* 아래 폴백 */
          }
          showToast.error('다른 곳에서 변경되어 다시 불러옵니다')
          setBytes(null)
          setGen((g) => g + 1)
          // 새 바이트로 리마운트한다 (편집 내용은 버려진다 — 잠금 만료 등 희귀 경로).
          void getAttachmentPart(parentPath, part, { roomId, clientId })
            .then(async (fresh) => {
              if (!mountedRef.current) return
              setBytes(fresh.bytes)
              setBaseHash(fresh.hash)
              baseHashRef.current = fresh.hash
              origBytesRef.current = fresh.bytes
              try {
                setOrigPartHash(await sha256Hex(fresh.bytes))
              } catch {
                /* 무시 */
              }
              setGen((g) => g + 1)
            })
            .catch(() => {})
          return false
        }
        if (r.code === 'dirty_room') {
          // 부모 저장 요청 후 1회 재시도 (무응답이면 중단).
          window.dispatchEvent(new CustomEvent('officeSaveRequest'))
          const ok = await waitParentSaveDone(parentPath, SAVE_WAIT_MS)
          if (!ok) {
            showToast.error('부모 파일을 먼저 저장하세요')
            return false
          }
          try {
            const fresh = await getAttachmentPart(parentPath, part, { roomId, clientId })
            baseHashRef.current = fresh.hash
            setBaseHash(fresh.hash)
            const r2 = await doPut(fresh.hash)
            if (r2.ok) {
              if (r2.newHash) {
                baseHashRef.current = r2.newHash
                setBaseHash(r2.newHash)
              }
              showToast.success('저장했습니다')
              return true
            }
            showToast.error(r2.error ?? '저장에 실패했습니다')
            return false
          } catch {
            showToast.error('저장에 실패했습니다')
            return false
          }
        }
        if (r.code === 'locked' || r.code === 'no_lock') {
          setReadOnly(true)
          showToast.error('편집 잠금을 잃었습니다. 읽기 전용으로 전환합니다')
          return false
        }
        if (r.code === 'view_only') {
          setReadOnly(true)
          showToast.error('보기 모드에서는 첨부할 수 없습니다')
          return false
        }
        showToast.error(r.error ?? '저장에 실패했습니다')
        return false
      } catch {
        showToast.error('저장에 실패했습니다')
        return false
      }
    },
    [parentPath, part, name, roomId, clientId, origPartHash],
  )

  const doSave = useCallback(async (): Promise<boolean> => {
    if (readOnly || saving) return false
    const s = saverRef.current
    if (!s) {
      // 뷰어 저장 슬롯이 아직 없으면 조용히 성공하지 않는다 (E2-unsaved: 무PUT 침묵 방지).
      showToast.error('편집기가 아직 준비되지 않았습니다. 잠시 후 다시 저장해 주세요')
      return false
    }
    // 명시적 저장은 dirty 여부와 무관하게 항상 PUT한다 (isDirty 오판 시 무PUT 침묵 방지).
    setSaving(true)
    try {
      const ok = await s.saveNow()
      if (ok) setDirtyTick((t) => t + 1)
      return ok
    } finally {
      if (mountedRef.current) setSaving(false)
    }
  }, [readOnly, saving])

  const requestClose = useCallback(() => {
    const s = saverRef.current
    if (!readOnly && s?.isDirty()) {
      setConfirmOpen(true)
      return
    }
    onClose()
  }, [readOnly, onClose])

  const closeAfterSave = useCallback(async () => {
    setConfirmOpen(false)
    const ok = await doSave()
    if (ok) onClose()
  }, [doSave, onClose])

  const closeDiscard = useCallback(() => {
    setConfirmOpen(false)
    onClose()
  }, [onClose])

  const viewerKey = `attach-${gen}`
  const viewerBytes = useMemo(() => {
    if (!bytes) return null
    // lib 뷰어가 ArrayBuffer 전체를 소유하도록 잘라낸 복사본을 넘긴다.
    const copy = new Uint8Array(bytes.length)
    copy.set(bytes)
    return copy.buffer
  }, [bytes])

  if (phase === 'loading') {
    return (
      <div className="fixed inset-0 z-[110] bg-background flex flex-col" data-testid="attach-editor">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border flex-shrink-0">
          <span className="text-sm text-muted-foreground">첨부 불러오는 중…</span>
        </div>
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">불러오는 중…</div>
      </div>
    )
  }

  if (phase === 'error' || !bytes || !viewerBytes) {
    return (
      <div className="fixed inset-0 z-[110] bg-background flex flex-col" data-testid="attach-editor">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border flex-shrink-0">
          <button type="button" onClick={onClose} data-testid="attach-back" className="h-7 text-xs px-2 rounded hover:bg-muted text-muted-foreground">
            ← 뒤로
          </button>
          <span className="text-sm font-medium truncate" data-testid="attach-title">
            {parentName} › {name}
          </span>
        </div>
        <div className="flex-1 flex items-center justify-center text-sm text-destructive p-4 text-center">
          {errorText || '첨부를 불러오지 못했습니다'}
        </div>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-[110] bg-background flex flex-col" data-testid="attach-editor">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border flex-shrink-0" data-testid="attach-header">
        <button
          type="button"
          onClick={requestClose}
          data-testid="attach-back"
          className="h-7 text-xs px-2 rounded hover:bg-muted text-muted-foreground"
          title="닫기"
        >
          ← 뒤로
        </button>
        <span className="text-sm font-medium truncate" data-testid="attach-title" title={`${parentName} › ${name}`}>
          {parentName} › {name}
        </span>
        {readOnly ? (
          <span
            data-testid="attach-readonly"
            className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground flex-shrink-0"
          >
            읽기 전용
          </span>
        ) : (
          <span data-testid="attach-dirty" className="h-2 w-2 rounded-full bg-amber-500 flex-shrink-0" title="저장되지 않은 변경" />
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={() => void doSave()}
          disabled={readOnly || saving}
          data-testid="attach-save"
          className="h-7 text-xs px-3 rounded bg-primary text-primary-foreground disabled:opacity-50"
        >
          {saving ? '저장 중…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={requestClose}
          data-testid="attach-done"
          className="h-7 text-xs px-3 rounded border border-border hover:bg-muted"
        >
          Done
        </button>
      </div>
      <div className="flex-1 min-h-0 relative">
        {kind === 'pptx' && (
          <ViewerLoadBoundary onRetry={() => setGen((g) => g + 1)}>
            <PptxViewer
              key={viewerKey}
              data={viewerBytes}
              fileName={name}
              editing={!readOnly}
              standalone
              persistOverride={persist}
              registerSaver={(s) => {
                saverRef.current = s
              }}
              onFail={() => {
                setErrorText('이 첨부 파일을 열 수 없습니다')
                setPhase('error')
              }}
            />
          </ViewerLoadBoundary>
        )}
        {kind === 'xlsx' && (
          <ViewerLoadBoundary onRetry={() => setGen((g) => g + 1)}>
            <XlsxViewer
              key={viewerKey}
              data={viewerBytes}
              fileName={name}
              editing={!readOnly}
              path={parentPath}
              standalone
              persistOverride={persist}
              registerSaver={(s) => {
                saverRef.current = s
              }}
            />
          </ViewerLoadBoundary>
        )}
        {kind === 'docx' && (
          <ViewerLoadBoundary onRetry={() => setGen((g) => g + 1)}>
            <DocxViewer
              key={viewerKey}
              data={viewerBytes}
              fileName={name}
              editing={!readOnly}
              path={parentPath}
              standalone
              persistOverride={persist}
              registerSaver={(s) => {
                saverRef.current = s
              }}
            />
          </ViewerLoadBoundary>
        )}
      </div>
      <Dialog open={confirmOpen} onOpenChange={(o) => !o && setConfirmOpen(false)}>
        <DialogContent data-testid="attach-confirm">
          <DialogHeader>
            <DialogTitle>저장하지 않은 내용이 있습니다</DialogTitle>
            <DialogDescription>첨부의 변경 내용을 어떻게 할까요?</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={closeDiscard} data-testid="attach-confirm-discard">
              저장 안 함
            </Button>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)} data-testid="attach-confirm-cancel">
              취소
            </Button>
            <Button onClick={() => void closeAfterSave()} data-testid="attach-confirm-save">
              저장 후 닫기
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
