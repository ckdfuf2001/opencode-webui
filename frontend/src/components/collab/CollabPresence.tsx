import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { Pencil } from 'lucide-react'
import { peerActivity } from '@/lib/usePeers'
import type { PresencePeerView } from './collabPresenceView'
import { displayName, peerInitials } from './collabPresenceView'

/**
 * C1: 접속자 표시 통일 (PPT/XLSX 공용).
 * C3: 아바타 줄 + 팝오버. 클릭은 팝오버를 열고, 따라가기·이름 변경은 팝오버 안에서 한다.
 * - 아바타에는 data-* 식별자(data-peer-id/mode/owner/self/slide...)를 둔다.
 *   E21(data-owner), E3(data-slide, data-peer-id) 회귀는 아바타에서 계속 만족한다.
 * - 팝오버는 열려 있을 때만 DOM에 둔다(data-testid="collab-popover").
 * 표시용 변환(displayName/peerToView/peerInitials)은 ./collabPresenceView에 있다
 * (react-refresh only-export-components 규칙: 이 파일은 컴포넌트만 둔다).
 */

/**
 * M7-2: 1초마다 갱신되는 시각 컨텍스트.
 *
 * "N초 전 편집" 같은 상대 시간과 data-activity가 매초 바뀌어야 하는데,
 * 그 갱신을 뷰어가 감으면 덱 트리 전체가 리렌더된다(24슬라이드 SVG → 레이아웃
 * 객체가 GC를 기다리며 렌더러 메모리 증가). 그래서 시각을 컨텍스트로 내보내고
 * **그 값을 쓰는 아바타만** 다시 그리게 한다.
 */
const NowCtx = createContext(0)

export function NowProvider({ children, active = false }: { children: ReactNode; active?: boolean }): ReactNode {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    // 아무도 편집 중이 아니면 상대 시간 표시가 바뀔 일이 없으므로 느리게 돌린다.
    // (유휴 상태 interval 실행 횟수를 M7-4 기준으로 낮추기 위함)
    const ms = active ? 1000 : 5000
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [active])
  return <NowCtx.Provider value={now}>{children}</NowCtx.Provider>
}

const MAX_AVATARS = 6

function AvatarDot({ p, active }: { p: PresencePeerView; active: boolean }): ReactNode {
  const editing = active
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full text-[10px] font-semibold shrink-0 w-6 h-6${
        editing ? ' animate-pulse' : ''
      }`}
      style={
        editing
          ? { backgroundColor: p.color, color: '#fff' }
          : { border: `1.5px solid ${p.color}`, color: p.color, backgroundColor: 'transparent' }
      }
      aria-hidden="true"
    >
      {peerInitials(p.name)}
    </span>
  )
}

/**
 * C1: 통합 presence 컨테이너. testid `collab-presence`가 C1의 존재 단언이다.
 */
export function CollabPresenceShell({ children }: { children: ReactNode }): ReactNode {
  return <div data-testid="collab-presence">{children}</div>
}

export interface CollabPresenceBarProps {
  peers: PresencePeerView[];
  /** C3: 아바타 클릭은 팝오버를 열고 닫는다 (따라가기는 팝오버 안에서). */
  defaultOpen?: boolean;
  /** 따라가기 중인 참가자 id (없으면 null). */
  followId?: string | number | null;
  /** 팝오버의 따라가기 버튼 토글. */
  onFollowToggle?: (id: string) => void;
  /** 팝오버의 내 이름 저장 (빈 값은 호출되지 않는다). */
  onRename?: (name: string) => void;
  /** 바깥 클릭으로 팝오버가 닫힐 때 (캔버스를 직접 조작하려는 의도로 보고 따라가기를 푼다). */
  onDismiss?: () => void;
}

/**
 * C3: 아바타 줄 + 팝오버. 상단에는 아바타만 남는다 (viewer/editor 숫자·"나" 표기 없음).
 * - data-owner는 아바타에 둔다 (E21이 DOM에서 바로 읽는다).
 * - 팝오버는 열려 있을 때만 DOM에 만든다.
 */
export function CollabPresenceBar({ peers, defaultOpen = false, followId = null, onFollowToggle, onRename, onDismiss }: CollabPresenceBarProps): ReactNode {
  const [open, setOpen] = useState(defaultOpen)
  const [renaming, setRenaming] = useState(false)
  const [renameInput, setRenameInput] = useState('')
  const shown = peers.slice(0, MAX_AVATARS)
  const extra = peers.length - shown.length
  const self = peers.find((p) => p.isSelf) ?? null
  const submitRename = (): void => {
    const name = renameInput.trim()
    if (!name) return
    onRename?.(name)
    // 이름 변경은 확정 동작이므로 팝오버를 닫는다 (세션 재참가로 바가 바뀌어도 상태가 꼬이지 않는다).
    setRenaming(false)
    setOpen(false)
  }

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // window 캡처에서 먼저 받아 document 버블/캡처의 모달 닫기(FileBrowser,
      // FilePreview 전체화면 종료 → endEditing → 편집 모드 종료)까지 전파되지
      // 않게 한다. Esc 1번 = 팝오버만 닫는다.
      e.stopPropagation()
      // 이름 입력칸의 Esc(편집 취소)는 입력칸이 처리하므로 팝오버는 열어 둔다.
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return
      setOpen(false)
    }
    // 바깥 클릭은 아래 투명 오버레이가 받는다 (lib 그리드가 DOM 이벤트를 가로채도 닫힌다).
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  return (
    <div data-testid="collab-presence-bar" className="relative flex items-center gap-2 px-3 py-1 border-b border-border text-[11px] text-muted-foreground">
      <NowProvider active={false}>
        <PresenceAvatars peers={shown} extra={extra} open={open} onToggle={() => setOpen((v) => !v)} />
      </NowProvider>
      {open && (
        <div
          data-testid="collab-popover-backdrop"
          aria-hidden="true"
          onClick={() => { setOpen(false); onDismiss?.() }}
          className="fixed inset-0 z-40 cursor-default"
        />
      )}
      {open && (
        <div
          data-testid="collab-popover"
          role="list"
          aria-label="참가자 목록"
          className="absolute left-2 top-full z-50 mt-1 min-w-56 max-w-72 rounded-md border border-border bg-background shadow-lg"
        >
          {self && (
            <div
              key={self.id}
              role="listitem"
              data-testid="collab-presence-row"
              data-peer-id={self.id}
              data-self="true"
              className="flex items-center gap-2 px-3 py-1.5 text-xs border-b border-border"
            >
              <AvatarDot p={self} active={false} />
              {renaming ? (
                <>
                <input
                  data-testid="collab-rename-input"
                  className="h-6 min-w-0 flex-1 rounded border border-input bg-background px-2 text-xs outline-none"
                  value={renameInput}
                  autoFocus
                  maxLength={64}
                  onChange={(e) => setRenameInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') submitRename()
                    if (e.key === 'Escape') { e.stopPropagation(); setRenaming(false) }
                  }}
                />
                <button
                  type="button"
                  data-testid="collab-rename-submit"
                  disabled={renameInput.trim().length === 0}
                  onClick={() => submitRename()}
                  className="h-6 shrink-0 rounded border border-border px-2 font-medium hover:bg-muted disabled:opacity-40"
                >
                  저장
                </button>
                </>
              ) : (
                <>
                  <span data-testid="collab-peer-name" className="truncate flex-1">{displayName(self)}</span>
                  <span data-testid="collab-peer-mode" className="shrink-0 text-muted-foreground">{self.mode === 'view' ? '보기' : '편집'}</span>
                  <button
                    type="button"
                    data-testid="collab-rename-edit"
                    title="이름 변경"
                    onClick={() => { setRenameInput(self.name); setRenaming(true) }}
                    className="shrink-0 rounded p-1 hover:bg-muted"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                </>
              )}
            </div>
          )}
          {peers.filter((p) => !p.isSelf).map((p) => {
            const following = followId != null && String(followId) === p.id
            return (
              <div
                key={p.id}
                role="listitem"
                data-testid="collab-presence-row"
                data-peer-id={p.id}
                data-self="false"
                data-following={following ? 'true' : 'false'}
                className="flex items-center gap-2 px-3 py-1.5 text-xs"
              >
                <AvatarDot p={p} active={false} />
                <span data-testid="collab-peer-name" className="truncate flex-1">{displayName(p)}</span>
                <span data-testid="collab-peer-mode" className="shrink-0 text-muted-foreground">{p.mode === 'view' ? '보기' : '편집'}</span>
                <button
                  type="button"
                  data-testid="collab-follow"
                  aria-pressed={following}
                  title={following ? `${p.name} 팔로우 중 (클릭하면 해제)` : `${p.name} 팔로우`}
                  onClick={() => onFollowToggle?.(p.id)}
                  className={`h-6 shrink-0 rounded border border-border px-2 font-medium hover:bg-muted${following ? ' underline decoration-dotted underline-offset-2' : ''}`}
                >
                  {following ? '해제' : '따라가기'}
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function PresenceAvatars({
  peers,
  extra,
  open,
  onToggle,
}: {
  peers: PresencePeerView[]
  extra: number
  open: boolean
  onToggle: () => void
}): ReactNode {
  const now = useContext(NowCtx)
  return (
    <button
      type="button"
      data-testid="collab-avatars"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={`참가자 ${peers.length + Math.max(0, extra)}명`}
      title="참가자 목록"
      // C3: 팝오버가 열리면 백드롭(fixed z-40)이 바 전체를 덮는다. 토글 버튼을
      // 위로 올리지 않으면 재클릭 닫기가 백드롭에 가로막혀 먹통이 된다.
      className={`inline-flex items-center -space-x-1 shrink-0 hover:opacity-90${open ? ' relative z-50' : ''}`}
    >
      {peers.map((p) => (
        <span
          key={p.id}
          data-testid="collab-peer"
          data-peer-id={p.id}
          data-mode={p.mode}
          {...(typeof p.slide === 'number' ? { 'data-slide': p.slide } : {})}
          {...(typeof p.sheetIndex === 'number' ? { 'data-sheet-index': p.sheetIndex } : {})}
          {...(typeof p.range === 'string' ? { 'data-range': p.range } : {})}
          data-owner={p.isOwner ? 'true' : 'false'}
          data-self={p.isSelf ? 'true' : 'false'}
          data-activity={peerActivity(p, now)}
          {...(p.selectedLabel ? { 'data-selected-label': p.selectedLabel } : {})}
          title={displayName(p)}
          className="inline-block rounded-full ring-2 ring-background"
        >
          <AvatarDot p={p} active={peerActivity(p, now) === 'editing'} />
        </span>
      ))}
      {extra > 0 && (
        <span className="inline-flex items-center justify-center rounded-full text-[10px] font-semibold w-6 h-6 shrink-0 bg-muted text-muted-foreground ring-2 ring-background">
          +{extra}
        </span>
      )}
    </button>
  )
}
