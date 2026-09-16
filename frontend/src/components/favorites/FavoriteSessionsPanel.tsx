import { useState, useEffect, useMemo, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Star, X, Send, Trash2, MessageSquare, FolderGit2, Eye, GripVertical, Loader2, ShieldAlert } from 'lucide-react'
import { CancelledBadge } from '../session/CancelledBadge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { listFavorites, removeFavorite } from '@/api/favorites'
import { useSessionStatusMap, useMessages, useSessions, clearCancelledUntilNextSend } from '@/hooks/useOpenCode'
import { permissionEvents } from '@/hooks/usePermissionRequests'
import { useEnqueueQueuedChat, useQueuedChats } from '@/hooks/useChatQueue'
import { useSettings } from '@/hooks/useSettings'
import { shouldPush, sendPushNotification } from '@/lib/notifications'
import { OPENCODE_API_ENDPOINT, API_BASE_URL } from '@/config'
import { showToast } from '@/lib/toast'
import { listRepos } from '@/api/repos'

export function FavoriteSessionsPanel() {
  const qc = useQueryClient()
  const [pinned, setPinned] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [resultFor, setResultFor] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [repoSelectedMap, setRepoSelectedMap] = useState<Record<string, { id: string; title: string }>>({})
  // 배지용 즐겨찾기는 패널 닫힘과 무관하게 유지 (부하는 favorites 1회 fetch 뿐).
  const { data: favorites = [], isLoading } = useQuery({ queryKey: ['favorites'], queryFn: listFavorites, staleTime: 10_000 })
  const { data: dbStatuses } = useSessionStatusMap()
  const { data: repos } = useQuery({ queryKey: ['repos'], queryFn: listRepos, enabled: pinned })
  const { preferences } = useSettings()

  const invalidate = () => qc.invalidateQueries({ queryKey: ['favorites'] })

  // 자동허용된 permission의 배지(방패) 즉시 정리 — 패널은 항상 마운트되므로 전역 커버.
  // 수동 dismiss는 usePermissionRequests.dismissPermission이 이미 처리한다.
  useEffect(() => {
    return permissionEvents.subscribe((event) => {
      const sid = event.type === 'remove' ? event.permission?.sessionID : undefined
      if (!sid) return
      qc.setQueryData(['session-status-db'], (old: unknown) => {
        if (!Array.isArray(old)) return old
        return (old as Array<{ sessionId: string; pendingPermissions?: number }>).map((s) =>
          s?.sessionId === sid ? { ...s, pendingPermissions: Math.max(0, (s.pendingPermissions ?? 1) - 1) } : s,
        )
      })
      qc.invalidateQueries({ queryKey: ['session-status-db'] })
    })
  }, [qc])

  // 즐겨찾기 세션 완료 푸시 (소리 없음 — 소리는 열린 세션에서만).
  // SessionDetail이 열려 있는 세션은 그쪽이 알리므로 중복 방지용으로 건너뛴다.
  // 레포 즐겨찾기는 집계 대상이라 제외 — 개별 세션 즐겨찾기가 담당한다.
  const prevFavBusyRef = useRef<Record<string, boolean>>({})
  useEffect(() => {
    if (!favorites.length || !dbStatuses?.length) return
    const prev = prevFavBusyRef.current
    const next: Record<string, boolean> = {}
    for (const f of favorites) {
      if (f.sessionId.startsWith('repo-')) continue
      const st = dbStatuses.find((s) => s.sessionId === f.sessionId)
      const busy = st?.status === 'busy'
      next[f.sessionId] = busy
      if (prev[f.sessionId] === true && !busy) {
        try {
          if (typeof window !== 'undefined' && window.location.pathname.includes(f.sessionId)) continue
        } catch {}
        if (!shouldPush(f.sessionId, preferences ?? {}, f.repoId ?? undefined)) continue
        const cancelled = (st as unknown as { isCancelled?: boolean } | undefined)?.isCancelled === true
        const title = cancelled ? '응답이 취소되었습니다' : '응답이 완료되었습니다'
        const dirName = (f.directory ?? '').split(/[/\\]+/).filter(Boolean).pop() ?? ''
        const body = `${dirName ? dirName + ' · ' : ''}${f.title || f.sessionId.slice(0, 8)}`
        const url = f.repoId ? `/repos/${f.repoId}/sessions/${f.sessionId}` : `/session/${f.sessionId}`
        void sendPushNotification(title, { body, tag: f.sessionId }, url, preferences?.pushNotificationDuration ?? 0)
      }
    }
    prevFavBusyRef.current = next
  }, [favorites, dbStatuses, preferences])

  // 리스트 순서 드래그 — localStorage에 순서 유지
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const orderedFavorites = useMemo(() => {
    try {
      const raw = localStorage.getItem('fav-order')
      if (!raw) return favorites
      const order: string[] = JSON.parse(raw)
      const map = new Map(favorites.map(f => [f.sessionId, f] as const))
      const sorted: typeof favorites = []
      for (const id of order) { const f = map.get(id); if (f) { sorted.push(f); map.delete(id) } }
      for (const f of map.values()) sorted.push(f)
      return sorted
    } catch { return favorites }
  }, [favorites])

  const persistFavOrder = (list: typeof favorites) => {
    try { localStorage.setItem('fav-order', JSON.stringify(list.map(f => f.sessionId))) } catch {}
    qc.setQueryData(['favorites'], list)
  }

  useEffect(() => {
    const h = () => { if (pinned) { setPinned(false); setResultFor(null); setActiveId(null); setRepoSelectedMap({}) } }
    window.addEventListener('global-escape-close', h as EventListener)
    return () => window.removeEventListener('global-escape-close', h as EventListener)
  }, [pinned])

  // 패널을 닫으면 즐겨찾기 목록 캐시를 즉시 비운다 (다음 열 때 새로 로드)
  // 배지 표시는 패널 닫힘과 무관하게 유지해야 하므로 제거하지 않는다.
  // (favorites는 수 KB 수준이라 유지해도 부하 없음)

  // 배지 합계 — 전역 useSessionStatusMap(2s 폴링)만 재사용, 추가 폴링 없음
  const badgeTotals = useMemo(() => {
    let working = 0
    let pending = 0
    let cancelled = 0
    if (!favorites.length || !dbStatuses?.length) return { working, pending, cancelled }
    for (const f of favorites) {
      const isRepoFav = f.sessionId.startsWith('repo-')
      if (isRepoFav) {
        // repo 일치: repoId 우선, 아니면 directory 문자열 일치
        const match = (s: { repoId?: number | null; directory?: string | null }) =>
          s.repoId === f.repoId || s.directory === f.directory
        working += dbStatuses.filter((s) => s.status === 'busy' && match(s)).length
        pending += dbStatuses.filter(match).reduce((a, s) => a + (s.pendingPermissions ?? 0), 0)
        cancelled += dbStatuses.filter((s) => (s as unknown as { isCancelled?: boolean }).isCancelled && s.status !== 'busy' && match(s)).length
      } else {
        const st = dbStatuses.find((s) => s.sessionId === f.sessionId)
        if (!st) continue
        if (st.status === 'busy') working += 1
        pending += st.pendingPermissions ?? 0
        if ((st as unknown as { isCancelled?: boolean }).isCancelled && st.status !== 'busy') cancelled += 1
      }
    }
    return { working, pending, cancelled }
  }, [favorites, dbStatuses])

  return (
    <>
      <div className="fixed bottom-[72px] left-0 z-[60] flex flex-col items-start gap-1">
        {(badgeTotals.working > 0 || badgeTotals.pending > 0 || badgeTotals.cancelled > 0) && (
          <button
            type="button"
            onClick={() => setPinned(true)}
            title="즐겨찾기 열기"
            className="relative ml-1 flex items-center gap-1 rounded-full border border-border bg-card/95 backdrop-blur px-1.5 py-1 shadow-md cursor-pointer hover:border-muted-foreground/40"
          >
            {badgeTotals.working > 0 && (
              <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-blue-600" title={`${badgeTotals.working} running`}>
                <Loader2 className="w-3 h-3 animate-spin" />{badgeTotals.working}
              </span>
            )}
            {badgeTotals.pending > 0 && (
              <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-amber-600" title={`${badgeTotals.pending} question(s) pending`}>
                <ShieldAlert className="w-3 h-3" />{badgeTotals.pending}
              </span>
            )}
            {badgeTotals.cancelled > 0 && (
              <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-zinc-500" title={`${badgeTotals.cancelled} cancelled`}>
                <CancelledBadge size="sm" />{badgeTotals.cancelled}
              </span>
            )}
            <div className="absolute -bottom-[5px] left-2 w-0 h-0 border-x-[4px] border-x-transparent border-t-[6px] border-t-card drop-shadow-[0_1px_0_hsl(var(--border))]" />
          </button>
        )}
        <button
          type="button"
          onClick={() => setPinned(v => !v)}
          className={`w-10 h-10 rounded-r-full border border-l-0 shadow-lg flex items-center justify-center transition-all -translate-x-1/2 hover:translate-x-0
            ${pinned ? 'bg-amber-500 text-white border-amber-600' : 'bg-card border-border text-muted-foreground hover:text-foreground hover:bg-card'}`}
          title={pinned ? '즐겨찾기 고정 해제 (클릭)' : '즐겨찾기 (클릭하여 열기)'}
        >
          <Star className={`w-5 h-5 ${pinned ? 'fill-white' : ''}`} />
        </button>
      </div>
      {pinned && (
        <div className="fixed bottom-[84px] left-4 z-[60] w-[340px] max-w-[88vw] rounded-lg border border-border bg-card shadow-2xl overflow-hidden flex flex-col max-h-[60vh]">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <span className="text-xs font-semibold">즐겨찾기</span>
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setPinned(false)}><X className="w-3.5 h-3.5" /></Button>
          </div>
          <div className="overflow-auto flex-1 p-2 space-y-2 bg-card">
            {isLoading && <div className="text-xs text-muted-foreground p-2">로딩...</div>}
            {!isLoading && favorites.length === 0 && <div className="text-xs text-muted-foreground p-4 text-center">즐겨찾기한 세션이 없습니다.<br/>워크스페이스/세션 목록에서 별표를 눌러 추가하세요.</div>}
            {orderedFavorites.map((f, idx) => {
              const isRepoFav = f.sessionId.startsWith('repo-')
              const repo = repos?.find(r => r.id === f.repoId || r.fullPath === f.directory)
              const status = isRepoFav ? null : dbStatuses?.find(s => s.sessionId === f.sessionId)
              const busy = status?.status === 'busy'
              // 레포 즐겨찾기: workspace처럼 레포 단위 집계 배찌 (개수 포함)
              const matchRepo = (s: { repoId?: number | null; directory?: string | null }) =>
                isRepoFav && (s.repoId === f.repoId || (repo && s.directory === repo.fullPath) || s.directory === f.directory)
              const repoWorking = isRepoFav ? (dbStatuses?.filter(s => s.status === 'busy' && matchRepo(s)).length ?? 0) : 0
              const repoPending = isRepoFav ? (dbStatuses?.filter(s => matchRepo(s)).reduce((a, s) => a + (s.pendingPermissions ?? 0), 0) ?? 0) : 0
              const repoCancelled = isRepoFav ? (dbStatuses?.filter(s => (s as unknown as { isCancelled?: boolean }).isCancelled && s.status !== 'busy' && matchRepo(s)).length ?? 0) : 0
              const isActive = activeId === f.sessionId
              const isDragging = dragIdx === idx
              return (
                <div
                  key={f.sessionId}
                  draggable
                  onDragStart={() => setDragIdx(idx)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault()
                    if (dragIdx === null || dragIdx === idx) return
                    const list = [...orderedFavorites]
                    const [moved] = list.splice(dragIdx, 1)
                    list.splice(idx, 0, moved)
                    persistFavOrder(list)
                    setDragIdx(null)
                  }}
                  onDragEnd={() => setDragIdx(null)}
                  onClick={() => {
                    if (dragIdx !== null) return
                    const closing = activeId === f.sessionId
                    const next = closing ? null : f.sessionId
                    setActiveId(next)
                    // 리스트를 다시 닫으면 결과도 함께 닫고, 다른 아이템으로 이동 시 이전 결과 닫기
                    if (closing) {
                      if (resultFor === f.sessionId) setResultFor(null)
                      setRepoSelectedMap(prev => { const n = { ...prev }; delete n[f.sessionId]; return n })
                    } else if (resultFor && resultFor !== f.sessionId) {
                      setResultFor(null)
                    }
                  }}
                  className={`border rounded-md p-2 space-y-1.5 bg-background cursor-pointer transition-colors ${isActive ? 'border-blue-500 ring-1 ring-blue-500/30 bg-blue-50/40 dark:bg-blue-950/20' : 'border-border hover:border-muted-foreground/30'} ${isDragging ? 'opacity-50 ring-2 ring-amber-400' : ''}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="cursor-grab active:cursor-grabbing p-0.5 -ml-1 text-muted-foreground hover:text-foreground" draggable={false} onClick={e => e.stopPropagation()} onMouseDown={e => e.stopPropagation()}><GripVertical className="w-3 h-3" /></span>
                        {isRepoFav ? <FolderGit2 className="w-3.5 h-3.5 shrink-0 text-muted-foreground" /> : <MessageSquare className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />}
                        <span className="text-xs font-medium truncate" title={f.title}>{f.title}</span>
                        {busy && <span title="Working" className="inline-flex shrink-0"><Loader2 className="w-3 h-3 animate-spin text-blue-500" /></span>}
                        {status?.isCancelled && !busy && <CancelledBadge size="sm" />}
                        {isRepoFav && <span className="text-[10px] px-1 py-0 rounded bg-muted text-muted-foreground">레포</span>}
                        {isRepoFav && repoWorking > 0 && (
                          <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-blue-500" title={`${repoWorking} session(s) working`}>
                            <Loader2 className="w-3 h-3 animate-spin" />{repoWorking}
                          </span>
                        )}
                        {isRepoFav && repoPending > 0 && (
                          <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-amber-500" title={`${repoPending} approval(s) pending`}>
                            <ShieldAlert className="w-3 h-3" />{repoPending}
                          </span>
                        )}
                        {isRepoFav && repoCancelled > 0 && (
                          <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-gray-500" title={`${repoCancelled} cancelled`}>
                            <CancelledBadge size="sm" />{repoCancelled}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-muted-foreground truncate">{repo?.localPath || f.directory || f.sessionId.slice(0, 8)}</div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0" onClick={e => e.stopPropagation()}>
                      {!isRepoFav && <Button variant="ghost" size="sm" className="h-6 text-xs px-2" asChild><a href={f.repoId ? `/repos/${f.repoId}/sessions/${f.sessionId}` : `/session/${f.sessionId}`}>이동</a></Button>}
                      {isRepoFav && <Button variant="ghost" size="sm" className="h-6 text-xs px-2" asChild><a href={f.repoId ? `/repos/${f.repoId}` : '/'}>이동</a></Button>}
                      <Button variant="ghost" size="icon" className="h-6 w-6" onClick={async () => { try { await removeFavorite(f.sessionId); showToast.success('즐겨찾기 해제'); invalidate(); setActiveId(prev => prev === f.sessionId ? null : prev) } catch (e:any){ showToast.error(e.message) } }} title="삭제"><Trash2 className="w-3.5 h-3.5" /></Button>
                    </div>
                  </div>
                  {isActive && (
                    <>
                      <div className="flex gap-1" onClick={e => e.stopPropagation()}>
                        <Input
                          autoFocus
                          placeholder={isRepoFav ? (repoSelectedMap[f.sessionId] ? `${repoSelectedMap[f.sessionId].title} 에 전송...` : "새 세션으로 채팅...") : "퀵챗..."}
                          value={drafts[f.sessionId] ?? ''}
                          onChange={e => setDrafts(prev => ({ ...prev, [f.sessionId]: e.target.value }))}
                          onKeyDown={e => {
                            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); (e.target as HTMLInputElement).nextElementSibling?.dispatchEvent(new MouseEvent('click', { bubbles: true })) }
                          }}
                          className="h-7 text-xs flex-1 border-blue-400 focus-visible:border-blue-500 focus-visible:ring-blue-500/30"
                        />
                        <MiniSendButton sessionId={f.sessionId} directory={f.directory} draft={drafts[f.sessionId] ?? ''} selectedSessionId={isRepoFav ? (repoSelectedMap[f.sessionId]?.id ?? null) : undefined} onSent={() => setDrafts(prev => ({ ...prev, [f.sessionId]: '' }))} />
                        <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" title={isRepoFav ? "세션 목록 보기" : "결과 보기"} onClick={() => setResultFor(v => { const next = v === f.sessionId ? null : f.sessionId; if (next === null) setRepoSelectedMap(prev => { const n = { ...prev }; delete n[f.sessionId]; return n }); return next })}>
                        <Eye className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                    </>
                  )}
                  {resultFor === f.sessionId && !isRepoFav && (
                    <div onClick={e => e.stopPropagation()}>
                      <MiniResultPopup sessionId={f.sessionId} directory={f.directory} repoId={f.repoId} onClose={() => setResultFor(null)} />
                    </div>
                  )}
                  {resultFor === f.sessionId && isRepoFav && (
                    <div onClick={e => e.stopPropagation()}>
                      <RepoSessionsPopup repoId={f.repoId} directory={f.directory} selectedSessionId={repoSelectedMap[f.sessionId]?.id ?? null} onSessionSelect={(sid, title) => setRepoSelectedMap(prev => { const n = { ...prev }; if (sid) n[f.sessionId] = { id: sid, title: title ?? sid }; else delete n[f.sessionId]; return n })} onClose={() => { setResultFor(null); setRepoSelectedMap(prev => { const n = { ...prev }; delete n[f.sessionId]; return n }) }} />
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </>
  )
}

function extractText(parts: any[] | undefined): string | null {
  if (!parts) return null
  const t = parts.filter(p => p.type === 'text').map(p => (p as any).text).join('\n').trim()
  return t || null
}

/** 세션 상태 아이콘 배찌 (이름 텍스트 없이 아이콘만) */
function SessionBadges({ sessionId }: { sessionId: string }) {
  const { data: dbStatuses } = useSessionStatusMap()
  const st = dbStatuses?.find(s => s.sessionId === sessionId)
  if (!st) return null
  const busy = st.status === 'busy'
  const pending = st.pendingPermissions ?? 0
  const cancelled = (st as unknown as { isCancelled?: boolean }).isCancelled && !busy
  if (!busy && !pending && !cancelled) return null
  return (
    <span className="inline-flex items-center gap-1 shrink-0">
      {busy && <span title="Working" className="inline-flex"><Loader2 className="w-3 h-3 animate-spin text-blue-500" /></span>}
      {pending > 0 && !busy && (
        <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-amber-500" title={`${pending} approval(s) pending`}>
          <ShieldAlert className="w-3 h-3" />{pending}
        </span>
      )}
      {cancelled && !busy && !pending && <CancelledBadge size="sm" />}
    </span>
  )
}

function MiniResultPopup({ sessionId, directory, repoId, onClose }: { sessionId: string; directory: string; repoId?: number | null; onClose: () => void }) {
  const qc = useQueryClient()
  const dirKey = directory || undefined
  // 마지막 10개만 열 때 한 번 로드 — 폴링 없음 (배찌가 실시간 상태 표시 담당).
  // 전체를 들고 오면 pnpm 등 대량 툴 출력으로 GB가 되고, 도는 세션에 0.5~1초 폴링이 붙으면 더 부푼다
  const { data: messages, isLoading } = useMessages(OPENCODE_API_ENDPOINT, sessionId, dirKey, 2, { poll: false })
  const [expanded, setExpanded] = useState(false)
  // 팝업을 닫으면 메시지 캐시를 즉시 비운다 (다음 열 때 새로 로드)
  useEffect(() => {
    return () => { qc.removeQueries({ queryKey: ['opencode', 'messages', OPENCODE_API_ENDPOINT, sessionId, dirKey, 2] }) }
  }, [qc, sessionId, dirKey])
  const lastUser = [...(messages ?? [])].reverse().find(m => (m.info as any)?.role === 'user')
  const lastAssistant = [...(messages ?? [])].reverse().find(m => (m.info as any)?.role === 'assistant')
  const lastUserText = extractText((lastUser as any)?.parts)
  const lastAssistantText = extractText((lastAssistant as any)?.parts)
  const userSnippet = lastUserText ? (lastUserText.length > 40 ? lastUserText.slice(0, 40) + '…' : lastUserText) : ''
  // sending/대기 중 큐는 opencode 메시지에 아직 없어서 lastUser에 안 잡힌다.
  // 타이틀에만 '마지막 결과 - <입력>'으로 표기하고, 본문(질문/응답)에는 찍지 않는다.
  // 본문에 찍으면 상단 타이틀과 중복되고, 아직 미전송이라 내용도 비어 있다.
  const { data: queuedChats = [] } = useQueuedChats(sessionId)
  const activeQueue = queuedChats.find(q => q.status === 'sending') ?? queuedChats.find(q => q.status === 'queued')
  const activeQueueText = activeQueue?.text?.trim() ?? ''
  const queueSnippet = activeQueueText ? (activeQueueText.length > 40 ? activeQueueText.slice(0, 40) + '…' : activeQueueText) : ''
  const titleSnippet = queueSnippet || userSnippet
  const titleFull = activeQueueText || lastUserText || undefined
  const moveUrl = repoId ? `/repos/${repoId}/sessions/${sessionId}` : `/session/${sessionId}`
  // 마지막 시퀀스: 마지막 user 이후의 user+assistant만 (전체보기용)
  const lastSequence = (() => {
    if (!messages || messages.length === 0) return []
    const idx = [...messages].reverse().findIndex(m => (m.info as any)?.role === 'user')
    if (idx === -1) {
      // user가 없으면 마지막 assistant만
      return lastAssistant ? [lastAssistant] : []
    }
    const lastUserIdx = messages.length - 1 - idx
    return messages.slice(lastUserIdx).filter((m: any) => {
      const txt = extractText((m as any).parts)
      return !!txt
    })
  })()
  return (
    <>
      <div className="mt-1 border rounded-md bg-muted/30 p-2 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium truncate flex items-center gap-1.5 min-w-0" title={titleFull}>
            <span className="truncate">{titleSnippet ? `마지막 결과 - ${titleSnippet}` : '마지막 결과'}</span>
            <SessionBadges sessionId={sessionId} />
          </span>
          <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={onClose}><X className="w-3 h-3" /></Button>
        </div>
        {isLoading && <div className="text-xs text-muted-foreground">불러오는 중...</div>}
        {!isLoading && !lastUserText && !lastAssistantText && <div className="text-xs text-muted-foreground">결과가 없습니다.</div>}
        {!isLoading && (lastUserText || lastAssistantText) && (
          <div className="space-y-1.5">
            {lastUserText && (
              <div className="text-xs whitespace-pre-wrap max-h-[12vh] overflow-auto bg-background border rounded p-2">
                <div className="text-[10px] font-medium opacity-60 mb-1">질문</div>
                <div>{lastUserText.slice(0, 2000)}</div>
              </div>
            )}
            {lastAssistantText && (
              <div className="text-xs whitespace-pre-wrap max-h-[20vh] overflow-auto bg-background border rounded p-2">
                <div className="text-[10px] font-medium opacity-60 mb-1">응답</div>
                <div>{lastAssistantText.slice(0, 4000)}</div>
              </div>
            )}
          </div>
        )}
        <div className="flex justify-end">
          <Button variant="outline" size="sm" className="h-6 text-xs" onClick={() => setExpanded(true)} disabled={!messages || messages.length === 0}>전체 보기</Button>
        </div>
      </div>
      {expanded && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4" onClick={() => setExpanded(false)}>
          <div className="bg-card border rounded-lg shadow-2xl w-[720px] max-w-[95vw] max-h-[85vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b gap-2">
              <span className="text-sm font-semibold truncate flex items-center gap-2 min-w-0" title={titleFull}>
                <span className="truncate">{titleSnippet ? `전체 보기 — ${titleSnippet}` : `전체 보기 — ${sessionId.slice(0, 8)}`}</span>
                <SessionBadges sessionId={sessionId} />
              </span>
              <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => setExpanded(false)}><X className="w-4 h-4" /></Button>
            </div>
            <div className="overflow-auto flex-1 p-4 space-y-3 bg-background">
              {lastSequence.length === 0 && <div className="text-sm text-muted-foreground">메시지가 없습니다.</div>}
              {lastSequence.map((m: any) => {
                const role = (m.info as any)?.role as string
                const txt = extractText(m.parts) ?? ''
                if (!txt) return null
                return (
                  <div key={(m.info as any)?.id || Math.random()} className={`rounded-lg border p-3 text-sm whitespace-pre-wrap ${role === 'user' ? 'bg-muted/50' : 'bg-card'}`}>
                    <div className="text-[11px] font-medium mb-1 opacity-60">{role === 'user' ? '사용자' : '어시스턴트'}</div>
                    <div>{txt.slice(0, 8000)}</div>
                  </div>
                )
              })}
            </div>
            <div className="flex justify-end gap-2 p-3 border-t bg-card">
              <Button variant="outline" size="sm" onClick={() => setExpanded(false)}>닫기</Button>
              <Button size="sm" asChild>
                <a href={moveUrl}>세션으로 이동</a>
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function RepoSessionsPopup({ repoId, directory, selectedSessionId, onSessionSelect, onClose }: { repoId: number | null; directory: string; selectedSessionId?: string | null; onSessionSelect?: (sid: string | null, title?: string) => void; onClose: () => void }) {
  const qc = useQueryClient()
  const dirKey = directory || undefined
  // 세션 목록은 열 때 한 번만 로드한다 (2초 폴링 없음 — 즐겨찾기 패널 메모리 대응).
  // Working/승인 배찌는 useSessionStatusMap 전역 폴링으로 실시간 갱신된다.
  const { data: sessions, isLoading } = useSessions(OPENCODE_API_ENDPOINT, dirKey, { poll: false, repoId: repoId ?? undefined })
  const { data: dbStatuses } = useSessionStatusMap()
  // 팝업을 닫으면 세션 목록 캐시를 즉시 비운다 (다음 열 때 새로 로드)
  useEffect(() => {
    return () => { qc.removeQueries({ queryKey: ['opencode', 'sessions', OPENCODE_API_ENDPOINT, dirKey] }) }
  }, [qc, dirKey])
  if (selectedSessionId) {
    return (
      <div className="mt-1">
        <MiniResultPopup sessionId={selectedSessionId} directory={directory} repoId={repoId} onClose={() => onSessionSelect?.(null)} />
      </div>
    )
  }
  return (
    <div className="mt-1 border rounded-md bg-muted/30 p-2 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium">세션 목록 — {sessions?.length ?? 0}개</span>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose}><X className="w-3 h-3" /></Button>
      </div>
      {isLoading && <div className="text-xs text-muted-foreground">불러오는 중...</div>}
      {!isLoading && (!sessions || sessions.length === 0) && <div className="text-xs text-muted-foreground">세션이 없습니다.</div>}
      {!isLoading && sessions && sessions.length > 0 && (
        <div className="space-y-1 max-h-[30vh] overflow-auto pr-1">
          {sessions.map((s: any) => {
            const sid = s.id as string
            const title = (s.title as string) || 'Untitled'
            const st = dbStatuses?.find(x => x.sessionId === sid)
            const busy = st?.status === 'busy'
            const pending = st?.pendingPermissions ?? 0
            const cancelled = (st as unknown as { isCancelled?: boolean } | undefined)?.isCancelled && !busy
            return (
              <div key={sid} className="flex items-center gap-2 p-2 rounded border bg-background hover:bg-muted/50 cursor-pointer" onClick={() => onSessionSelect?.(sid, title)}>
                <MessageSquare className="w-3 h-3 shrink-0 text-muted-foreground" />
                <span className="flex-1 truncate text-xs font-medium" title={title}>{title}</span>
                {busy && <span title="Working" className="inline-flex shrink-0"><Loader2 className="w-3 h-3 animate-spin text-blue-500" /></span>}
                {pending > 0 && !busy && (
                  <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-amber-500 shrink-0" title={`${pending} approval(s) pending`}>
                    <ShieldAlert className="w-3 h-3" />{pending}
                  </span>
                )}
                {cancelled && !busy && !pending && <CancelledBadge size="sm" />}
                <Button size="sm" className="h-6 text-xs px-2 shrink-0" asChild>
                  <a href={repoId ? `/repos/${repoId}/sessions/${sid}` : `/session/${sid}`} onClick={(e) => e.stopPropagation()}>이동</a>
                </Button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function MiniSendButton({ sessionId, directory, draft, selectedSessionId, onSent }: { sessionId: string; directory: string; draft: string; selectedSessionId?: string | null; onSent: () => void }) {
  const isRepoFav = sessionId.startsWith('repo-')
  const enqueue = useEnqueueQueuedChat()
  const qc = useQueryClient()
  const [sending, setSending] = useState(false)
  const handle = async () => {
    const text = draft.trim()
    if (!text) return
    // 입력창 즉시 비우기 (큐 전송은 백그라운드)
    onSent()
    setSending(true)
    try {
      let targetId = sessionId
      if (isRepoFav) {
        if (selectedSessionId) {
          targetId = selectedSessionId
          try { clearCancelledUntilNextSend(targetId) } catch {}
          try { await fetch(`${API_BASE_URL}/api/session-status/${encodeURIComponent(targetId)}/cancelled`, { method: 'DELETE' }) } catch {}
        } else {
          const res = await fetch(`${API_BASE_URL}/api/opencode/session?directory=${encodeURIComponent(directory)}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: text.slice(0, 40) })
          })
          if (!res.ok) throw new Error(`세션 생성 실패 (${res.status})`)
          const data = await res.json() as { id: string }
          if (!data.id) throw new Error('세션 생성 응답 이상')
          targetId = data.id
        }
      } else {
        try { clearCancelledUntilNextSend(targetId) } catch {}
        try { await fetch(`${API_BASE_URL}/api/session-status/${encodeURIComponent(targetId)}/cancelled`, { method: 'DELETE' }) } catch {}
      }
      // 큐 경유 발송 — PromptInput과 동일 경로 (busy/취소 중에도 유실 없이 순서 보존)
      await enqueue.mutateAsync({ sessionID: targetId, text, directory: directory || undefined } as any)
      qc.invalidateQueries({ queryKey: ['session-status-db'] })
      qc.invalidateQueries({ queryKey: ['chat-queue', targetId] })
      if (isRepoFav) {
        showToast.success(selectedSessionId ? '선택된 세션 큐에 추가됨' : '새 세션 큐에 추가됨')
      } else {
        showToast.success('큐에 추가됨')
      }
    } catch (e: any) {
      showToast.error(e?.message || '전송 실패')
    } finally { setSending(false) }
  }
  return <Button size="sm" className="h-7 px-2" disabled={sending || !draft.trim()} onClick={handle}><Send className="w-3 h-3" /></Button>
}
