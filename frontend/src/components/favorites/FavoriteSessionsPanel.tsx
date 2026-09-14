import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Star, X, Send, Trash2, MessageSquare, FolderGit2, Eye } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { listFavorites, removeFavorite } from '@/api/favorites'
import { useSendPrompt, useSessionStatusMap, useMessages } from '@/hooks/useOpenCode'
import { OPENCODE_API_ENDPOINT, API_BASE_URL } from '@/config'
import { showToast } from '@/lib/toast'
import { listRepos } from '@/api/repos'

export function FavoriteSessionsPanel() {
  const qc = useQueryClient()
  const [pinned, setPinned] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [resultFor, setResultFor] = useState<string | null>(null)
  const { data: favorites = [], isLoading } = useQuery({ queryKey: ['favorites'], queryFn: listFavorites, enabled: pinned, staleTime: 10_000 })
  const { data: dbStatuses } = useSessionStatusMap()
  const { data: repos } = useQuery({ queryKey: ['repos'], queryFn: listRepos, enabled: pinned })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['favorites'] })

  return (
    <>
      <button
        type="button"
        onClick={() => setPinned(v => !v)}
        className={`fixed bottom-[72px] left-0 z-[60] w-10 h-10 rounded-r-full border border-l-0 shadow-lg flex items-center justify-center transition-all -translate-x-1/2 hover:translate-x-0
          ${pinned ? 'bg-amber-500 text-white border-amber-600' : 'bg-card border-border text-muted-foreground hover:text-foreground hover:bg-card'}`}
        title={pinned ? '즐겨찾기 고정 해제 (클릭)' : '즐겨찾기 (클릭하여 열기)'}
      >
        <Star className={`w-5 h-5 ${pinned ? 'fill-white' : ''}`} />
      </button>
      {pinned && (
        <div className="fixed bottom-[84px] left-4 z-[60] w-[340px] max-w-[88vw] rounded-lg border border-border bg-card shadow-2xl overflow-hidden flex flex-col max-h-[60vh]">
          <div className="flex items-center justify-between px-3 py-2 border-b border-border">
            <span className="text-xs font-semibold">즐겨찾기</span>
            <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setPinned(false)}><X className="w-3.5 h-3.5" /></Button>
          </div>
          <div className="overflow-auto flex-1 p-2 space-y-2 bg-card">
            {isLoading && <div className="text-xs text-muted-foreground p-2">로딩...</div>}
            {!isLoading && favorites.length === 0 && <div className="text-xs text-muted-foreground p-4 text-center">즐겨찾기한 세션이 없습니다.<br/>워크스페이스/세션 목록에서 별표를 눌러 추가하세요.</div>}
            {favorites.map(f => {
              const isRepoFav = f.sessionId.startsWith('repo-')
              const repo = repos?.find(r => r.id === f.repoId || r.fullPath === f.directory)
              const status = isRepoFav ? null : dbStatuses?.find(s => s.sessionId === f.sessionId)
              const busy = status?.status === 'busy'
              return (
                <div key={f.sessionId} className="border rounded-md p-2 space-y-1.5 bg-background">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        {isRepoFav ? <FolderGit2 className="w-3.5 h-3.5 shrink-0 text-muted-foreground" /> : <MessageSquare className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />}
                        <span className="text-xs font-medium truncate" title={f.title}>{f.title}</span>
                        {busy && <span className="text-[10px] px-1.5 py-0 rounded-full bg-amber-500 text-white">Working</span>}
                        {status?.isCancelled && <span className="text-[10px] px-1.5 py-0 rounded-full bg-red-500 text-white">Cancelled</span>}
                        {isRepoFav && <span className="text-[10px] px-1 py-0 rounded bg-muted text-muted-foreground">레포</span>}
                      </div>
                      <div className="text-[11px] text-muted-foreground truncate">{repo?.localPath || f.directory || f.sessionId.slice(0, 8)}</div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      {!isRepoFav && <Button variant="ghost" size="sm" className="h-6 text-xs px-2" onClick={() => { const url = f.repoId ? `/repos/${f.repoId}/sessions/${f.sessionId}` : `/session/${f.sessionId}`; window.location.href = url }}>이동</Button>}
                      {isRepoFav && <Button variant="ghost" size="sm" className="h-6 text-xs px-2" onClick={() => { const url = f.repoId ? `/repos/${f.repoId}` : '/'; window.location.href = url }}>이동</Button>}
                      <Button variant="ghost" size="icon" className="h-6 w-6" onClick={async () => { try { await removeFavorite(f.sessionId); showToast.success('즐겨찾기 해제'); invalidate() } catch (e:any){ showToast.error(e.message) } }} title="삭제"><Trash2 className="w-3.5 h-3.5" /></Button>
                    </div>
                  </div>
                  <div className="flex gap-1">
                    <Input
                      placeholder={isRepoFav ? "새 세션으로 채팅..." : "미니 채팅..."}
                      value={drafts[f.sessionId] ?? ''}
                      onChange={e => setDrafts(prev => ({ ...prev, [f.sessionId]: e.target.value }))}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); (e.target as HTMLInputElement).nextElementSibling?.dispatchEvent(new MouseEvent('click', { bubbles: true })) }
                      }}
                      className="h-7 text-xs flex-1"
                    />
                    <MiniSendButton sessionId={f.sessionId} directory={f.directory} draft={drafts[f.sessionId] ?? ''} onSent={() => setDrafts(prev => ({ ...prev, [f.sessionId]: '' }))} />
                    <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" title="결과 보기" onClick={() => setResultFor(f.sessionId)} disabled={isRepoFav}>
                      <Eye className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                  {resultFor === f.sessionId && !isRepoFav && (
                    <MiniResultPopup sessionId={f.sessionId} directory={f.directory} onClose={() => setResultFor(null)} />
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

function MiniResultPopup({ sessionId, directory, onClose }: { sessionId: string; directory: string; onClose: () => void }) {
  const { data: messages, isLoading } = useMessages(OPENCODE_API_ENDPOINT, sessionId, directory || undefined)
  const [expanded, setExpanded] = useState(false)
  const lastAssistant = [...(messages ?? [])].reverse().find(m => (m.info as any)?.role === 'assistant')
  const lastText = (() => {
    if (!lastAssistant) return null
    const parts = (lastAssistant as any).parts as any[] | undefined
    if (!parts) return null
    const t = parts.filter(p => p.type === 'text').map(p => (p as any).text).join('\n').trim()
    return t || null
  })()
  return (
    <>
      <div className="mt-1 border rounded-md bg-muted/30 p-2 space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[11px] font-medium">마지막 결과</span>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onClose}><X className="w-3 h-3" /></Button>
        </div>
        {isLoading && <div className="text-xs text-muted-foreground">불러오는 중...</div>}
        {!isLoading && !lastText && <div className="text-xs text-muted-foreground">결과가 없습니다.</div>}
        {!isLoading && lastText && (
          <div className="text-xs whitespace-pre-wrap max-h-[20vh] overflow-auto bg-background border rounded p-2">
            {lastText.slice(0, 4000)}
          </div>
        )}
        <div className="flex justify-end">
          <Button variant="outline" size="sm" className="h-6 text-xs" onClick={() => setExpanded(true)} disabled={!messages || messages.length === 0}>전체 보기</Button>
        </div>
      </div>
      {expanded && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4" onClick={() => setExpanded(false)}>
          <div className="bg-card border rounded-lg shadow-2xl w-[720px] max-w-[95vw] max-h-[85vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <span className="text-sm font-semibold">전체 결과 — {sessionId.slice(0, 8)}</span>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setExpanded(false)}><X className="w-4 h-4" /></Button>
            </div>
            <div className="overflow-auto flex-1 p-4 space-y-3 bg-background">
              {(messages ?? []).length === 0 && <div className="text-sm text-muted-foreground">메시지가 없습니다.</div>}
              {(messages ?? []).map((m: any) => {
                const role = (m.info as any)?.role as string
                const parts = (m.parts ?? []) as any[]
                const txt = parts.filter(p => p.type === 'text').map(p => p.text).join('\n').trim()
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
              <Button size="sm" onClick={() => { window.location.href = `/session/${sessionId}` }}>세션으로 이동</Button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function MiniSendButton({ sessionId, directory, draft, onSent }: { sessionId: string; directory: string; draft: string; onSent: () => void }) {
  const isRepoFav = sessionId.startsWith('repo-')
  const send = useSendPrompt(OPENCODE_API_ENDPOINT, directory || undefined)
  const [sending, setSending] = useState(false)
  const handle = async () => {
    const text = draft.trim()
    if (!text) return
    setSending(true)
    try {
      let targetId = sessionId
      if (isRepoFav) {
        // repo 즐겨찾기: 새 세션을 만들어 전송
        const res = await fetch(`${API_BASE_URL}/api/opencode/session?directory=${encodeURIComponent(directory)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: text.slice(0, 40) })
        })
        if (!res.ok) throw new Error(`세션 생성 실패 (${res.status})`)
        const data = await res.json() as { id: string }
        if (!data.id) throw new Error('세션 생성 응답 이상')
        targetId = data.id
      }
      await new Promise<void>((resolve, reject) => {
        // @ts-ignore
        send.mutate({ sessionID: targetId, prompt: text } as any, { onSuccess: () => resolve(), onError: (e:any) => reject(e) })
      })
      onSent()
      showToast.success(isRepoFav ? '새 세션으로 전송됨' : '전송됨')
    } catch (e: any) {
      showToast.error(e?.message || '전송 실패')
    } finally { setSending(false) }
  }
  return <Button size="sm" className="h-7 px-2" disabled={sending || !draft.trim()} onClick={handle}><Send className="w-3 h-3" /></Button>
}
