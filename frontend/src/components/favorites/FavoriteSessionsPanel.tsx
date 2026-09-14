import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Star, X, Send, Trash2, MessageSquare, FolderGit2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { listFavorites, removeFavorite } from '@/api/favorites'
import { useSendPrompt, useSessionStatusMap } from '@/hooks/useOpenCode'
import { OPENCODE_API_ENDPOINT, API_BASE_URL } from '@/config'
import { showToast } from '@/lib/toast'
import { listRepos } from '@/api/repos'

export function FavoriteSessionsPanel() {
  const qc = useQueryClient()
  const [pinned, setPinned] = useState(false)
  const [drafts, setDrafts] = useState<Record<string, string>>({})
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
                    <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={async () => { try { await removeFavorite(f.sessionId); showToast.success('즐겨찾기 해제'); invalidate() } catch (e:any){ showToast.error(e.message) } }}><Trash2 className="w-3.5 h-3.5" /></Button>
                  </div>
                  <div className="flex gap-1">
                    <Input
                      placeholder={isRepoFav ? "새 세션으로 채팅..." : "미니 채팅..."}
                      value={drafts[f.sessionId] ?? ''}
                      onChange={e => setDrafts(prev => ({ ...prev, [f.sessionId]: e.target.value }))}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); (e.target as HTMLInputElement).nextElementSibling?.dispatchEvent(new MouseEvent('click', { bubbles: true })) }
                      }}
                      className="h-7 text-xs"
                    />
                    <MiniSendButton sessionId={f.sessionId} directory={f.directory} draft={drafts[f.sessionId] ?? ''} onSent={() => setDrafts(prev => ({ ...prev, [f.sessionId]: '' }))} />
                    {!isRepoFav && <Button variant="outline" size="sm" className="h-7 text-xs px-2" onClick={() => { window.location.href = `/repos/${f.repoId ?? ''}/sessions/${f.sessionId}`.replace('//','/') || `/session/${f.sessionId}` }}>열기</Button>}
                    {isRepoFav && <Button variant="outline" size="sm" className="h-7 text-xs px-2" onClick={() => { window.location.href = `/repos/${f.repoId}` }}>열기</Button>}
                  </div>
                </div>
              )
            })}
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
