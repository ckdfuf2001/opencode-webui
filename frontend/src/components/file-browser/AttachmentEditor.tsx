import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { showToast } from '@/lib/toast'
import { readCollabUser } from '@/lib/collabUser'
import { collabApi } from '@/api/collab'
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
import { waitParentSaveDone } from './officeSave'

const RENEW_MS = 20_000

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

/** U-stale: /edit URL에 파트 버전을 기록한다 (새로고침·공유 링크가 버전을 가진다). */
function stampPartHashUrl(hash: string | null): void {
  if (!hash) return
  try {
    const u = new URL(window.location.href)
    if (!u.pathname.startsWith('/edit/')) return
    if (u.searchParams.get('partHash') !== hash) {
      u.searchParams.set('partHash', hash)
      window.history.replaceState(null, '', `${u.pathname}${u.search}${u.hash}`)
    }
  } catch {
    /* 무시 */
  }
}

export default function AttachmentEditor({
  target,
  onClose,
  expectedPartHash,
}: {
  target: AttachmentOpenDetail
  onClose: () => void
  /** U-stale: ?partHash= 로 열린 딥링크의 기대 파트 해시. 다르면 알린다. */
  expectedPartHash?: string | null
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
  const [retryKey, setRetryKey] = useState(0)
  // C6c: 파트 방 공동편집 모드 (잠금 없이 둘이 같이 편집한다).
  const [collabMode, setCollabMode] = useState(false)
  const saverRef = useRef<AttachmentSaver | null>(null)
  const lockRef = useRef<{ lockId: string; token: string } | null>(null)
  // U-dirty-timeout: 부모 저장이 상한 안에 안 끝나면 미저장 내 사본을 준다.
  const [mineFile, setMineFile] = useState<{ url: string; name: string } | null>(null)
  const mineUrlRef = useRef<string | null>(null)
  useEffect(() => () => {
    if (mineUrlRef.current) {
      URL.revokeObjectURL(mineUrlRef.current)
      mineUrlRef.current = null
    }
  }, [])
  const baseHashRef = useRef<string | undefined>(undefined)
  const origBytesRef = useRef<Uint8Array | null>(null)
  const mountedRef = useRef(true)
  const holderName = useMemo(() => readCollabUser()?.name?.trim() || 'user', [])
  const tokenRef = useRef<string | null>(null)
  if (!tokenRef.current) tokenRef.current = randomToken()

  // U-close: 저장 안 된 첨부 편집이 있으면 탭 닫힘을 브라우저에 확인시킨다.
  // (뒤로 버튼은 requestClose→확인 다이얼로그가 처리, 여기는 직접 탭 닫기용.)
  useEffect(() => {
    if (readOnly) return
    const onBeforeUnload = (e: BeforeUnloadEvent): void => {
      let dirty = false
      try {
        dirty = saverRef.current?.isDirty?.() === true
      } catch {
        dirty = false
      }
      if (dirty) e.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [readOnly])

  // 열기: 바이트 수신 + (C6c 파트 방 공동편집 || 폴백 독점 잠금).
  useEffect(() => {
    mountedRef.current = true
    let dead = false
    const token = tokenRef.current!
    setPhase('loading')
    setErrorText('')
    setBytes(null)
    setCollabMode(false)
    setReadOnly(false)
  void (async () => {
    let partHash: string | null = null
    try {
      const got = await getAttachmentPart(parentPath, part, { roomId, clientId })
      if (dead) return
      setBytes(got.bytes)
      setBaseHash(got.hash)
      baseHashRef.current = got.hash
      origBytesRef.current = got.bytes
      // P0-4: 기준 해시는 서버가 준 파트 ETag를 쓴다 (subtle 없이도 strict 가능).
      // 서버가 안 준 구버전 대비로만 subtle 계산을 둔다.
      try {
        const h = got.partHash ?? (await sha256Hex(got.bytes))
        partHash = h
        setOrigPartHash(h)
        if (expectedPartHash && expectedPartHash !== h) {
          showToast.info('첨부가 바뀌었습니다 — 최신 내용으로 열었습니다')
        }
        stampPartHashUrl(h)
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
      // C6c: 하위문서 공동편집 — 파트 방에 붙으면 잠금 없이 같이 편집한다.
      // P0-4: strict는 항상 건다. knownHash는 GET ETag(서버 산출)라서
      // subtle 없는 http에서도 strict 검증이 된다.
      try {
        const info = await collabApi.session(
          parentPath,
          partHash ? { knownHash: partHash, strict: true, part } : { strict: true, part },
        )
        if (dead) return
        if (!info.stale) {
          setCollabMode(true)
          setReadOnly(false)
          setLockHolder(null)
          setPhase('ready')
          return
        }
        // stale이면 덮어쓰지 않고 에러로 알린다 (다시 열기로 최신 바이트 재수신).
        setErrorText('공유 상태가 어긋났습니다. 다시 열어 주세요.')
        setPhase('error')
        return
      } catch (e) {
        if (dead) return
        const code = (e as { code?: string })?.code
        if (code === 'stale_room' || code === 'stale_client' || code === 'external_change' || code === 'epoch_mismatch' || code === 'conflict') {
          setErrorText('공유 상태가 어긋났습니다. 다시 열어 주세요.')
          setPhase('error')
          return
        }
        // 세션 실패(오프라인 등)는 기존 독점 잠금 경로로 폴백한다.
      }
      try {
        const r = await acquireAttachmentLock(parentPath, part, holderName, token)
        if (dead) {
          await releaseAttachmentLock(parentPath, part, r.lockId, token).catch(() => {})
          return
        }
        lockRef.current = { lockId: r.lockId, token }
        setCollabMode(false)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 오픈 플로우 (retryKey로만 재실행)
  }, [retryKey])

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
          // U-stale: 파트 단위 낙관적 잠금. 연 시점 파트 해시를 함께 보내고,
          // 서버가 현재 파트와 다르면 stale_part로 막는다 (조용한 덮어쓰기 방지).
          partHash: origPartHash || undefined,
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
            const h = await sha256Hex(next)
            setOrigPartHash(h)
            stampPartHashUrl(h)
            origBytesRef.current = next
          } catch {
            /* 무시 */
          }
          showToast.success('저장했습니다')
          return true
        }
        if (r.code === 'stale' || r.code === 'stale_part') {
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
                const h2 = await sha256Hex(next)
                setOrigPartHash(h2)
                stampPartHashUrl(h2)
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
                const fh = await sha256Hex(fresh.bytes)
                setOrigPartHash(fh)
                stampPartHashUrl(fh)
              } catch {
                /* 무시 */
              }
              setGen((g) => g + 1)
            })
            .catch(() => {})
          return false
        }
        if (r.code === 'dirty_room') {
          // 부모 저장 요청 후 1회 재시도. 성공 done까지 최대 상한(기본 30초) 대기한다
          // (경합 중 낡은 저장의 실패 done에 포기하지 않는다 — U-flush-race).
          // 상한을 넘기면 저장 중을 풀고 실패 토스트 + 내 사본을 준다 (U-dirty-timeout).
          window.dispatchEvent(new CustomEvent('officeSaveRequest'))
          const ok = await waitParentSaveDone(parentPath)
          if (!ok) {
            try {
              if (mineUrlRef.current) URL.revokeObjectURL(mineUrlRef.current)
              const url = URL.createObjectURL(new Blob([next as unknown as BlobPart], { type: 'application/octet-stream' }))
              mineUrlRef.current = url
              const dot = name.lastIndexOf('.')
              const mineDlName = dot > 0 ? `${name.slice(0, dot)}.mine${name.slice(dot)}` : `${name}.mine`
              if (mountedRef.current) setMineFile({ url, name: mineDlName })
            } catch {
              /* 무시 */
            }
            showToast.error('부모 저장이 끝나지 않아 중단했습니다 — 내 사본을 내려받아 주세요')
            return false
          }
          try {
            const fresh = await getAttachmentPart(parentPath, part, { roomId, clientId })
            // U-stale: 부모 저장 뒤에도 파트가 바뀌어 있으면 덮어쓰지 않고 새로고침한다.
            let same = false
            try {
              same = (await sha256Hex(fresh.bytes)) === origPartHash
            } catch {
              same = false
            }
            if (!same) {
              showToast.error('다른 곳에서 변경되었습니다 — 다시 열기')
              setBytes(null)
              setGen((g) => g + 1)
              void getAttachmentPart(parentPath, part, { roomId, clientId })
                .then(async (f2) => {
                  if (!mountedRef.current) return
                  setBytes(f2.bytes)
                  setBaseHash(f2.hash)
                  baseHashRef.current = f2.hash
                  origBytesRef.current = f2.bytes
                  try {
                    const fh2 = await sha256Hex(f2.bytes)
                    setOrigPartHash(fh2)
                    stampPartHashUrl(fh2)
                  } catch {
                    /* 무시 */
                  }
                  setGen((g) => g + 1)
                })
                .catch(() => {})
              return false
            }
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
        <div className="flex-1 flex flex-col items-center justify-center gap-3 text-sm text-destructive p-4 text-center">
          <span>{errorText || '첨부를 불러오지 못했습니다'}</span>
          <button
            type="button"
            onClick={() => setRetryKey((k) => k + 1)}
            data-testid="attach-retry"
            className="h-7 text-xs px-3 rounded border border-border text-foreground hover:bg-muted"
          >
            다시 열기
          </button>
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
          onClick={() => {
            // C5-4: 편집 탭 타이틀바에서 원본 바이트를 내려받는다 (D63-판단1 유지).
            const b = origBytesRef.current
            if (!b) {
              showToast.error('원본을 불러오지 못했습니다')
              return
            }
            try {
              const url = URL.createObjectURL(new Blob([b as unknown as BlobPart], { type: 'application/octet-stream' }))
              const a = document.createElement('a')
              a.href = url
              a.download = name
              document.body.appendChild(a)
              a.click()
              a.remove()
              setTimeout(() => URL.revokeObjectURL(url), 5000)
            } catch {
              showToast.error('다운로드에 실패했습니다')
            }
          }}
          data-testid="attach-download"
          title="원본 바이트 다운로드"
          className="h-7 text-xs px-3 rounded border border-border hover:bg-muted"
        >
          다운로드
        </button>
        {mineFile && (
          <a
            href={mineFile.url}
            download={mineFile.name}
            data-testid="attach-mine"
            title="저장되지 않은 내 사본 다운로드"
            className="h-7 text-xs px-3 rounded border border-destructive text-destructive hover:bg-muted flex items-center"
          >
            내 사본
          </a>
        )}
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
              savePath={parentPath}
              part={part}
              standalone={!collabMode}
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
              part={part}
              etag={origPartHash || undefined}
              standalone={!collabMode}
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
              part={part}
              etag={origPartHash || undefined}
              standalone={!collabMode}
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
