import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { listExposed, createExposed, updateExposed, deleteExposed, listPublicCommands, listAvailableCommands, listExposeSessions } from '@/api/expose'
import { useCommands } from '@/hooks/useCommands'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { showToast } from '@/lib/toast'
import { Copy, Globe, ArrowUp, ArrowDown, ArrowUpDown, Search, Pencil, Home, ChevronDown, ChevronUp } from 'lucide-react'
import { getSystemInfo } from '@/api/system'
import { useNavigate } from 'react-router-dom'
import { Button as HeaderButton } from '@/components/ui/button'

export function ExposeCommands() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: exposed = [] } = useQuery({ queryKey: ['expose', 'commands'], queryFn: listExposed })
  const { data: publicData } = useQuery({ queryKey: ['public', 'commands'], queryFn: listPublicCommands })
  const { data: system } = useQuery({ queryKey: ['system', 'info'], queryFn: getSystemInfo })
  const { data: avail } = useQuery({ queryKey: ['expose', 'available'], queryFn: listAvailableCommands })
  const { commands: builtinCmds } = useCommands(null)

  // 파일 기반(global/project) + builtin 합쳐 소유 정보 포함
  const allCommands = useMemo(() => {
    const map = new Map<string, { name: string; description: string; scope: 'builtin'|'global'|'project'; repoName?: string; localPath?: string; repoId?: number }>()
    for (const c of builtinCmds) {
      if (!map.has(c.name)) map.set(c.name, { name: c.name, description: c.description ?? '', scope: 'builtin' })
    }
    for (const item of avail?.items ?? []) {
      const existing = map.get(item.name)
      // project/global이 builtin을 덮어씀 (실제 파일이 우선)
      if (!existing || existing.scope === 'builtin') map.set(item.name, { name: item.name, description: item.description || existing?.description || '', scope: item.scope, repoName: item.repoName, localPath: item.localPath, repoId: item.repoId })
      else if (existing.scope !== 'project' && item.scope === 'project') map.set(item.name, { name: item.name, description: item.description || existing.description, scope: item.scope, repoName: item.repoName, localPath: item.localPath, repoId: item.repoId })
    }
    return [...map.values()].sort((a,b) => a.name.localeCompare(b.name))
  }, [builtinCmds, avail])

  const [filter, setFilter] = useState('')
  const [descOpen, setDescOpen] = useState(false)
  const [editingEx, setEditingEx] = useState<typeof exposed[number] | null>(null)
  const [editForm, setEditForm] = useState<{ exposeName: string; description: string; sessionMode: 'new'|'reuse'; titleTemplate: string; pinnedSessionId: string; argsTemplate: string; exampleArgs: string; enabled: boolean }>({ exposeName: '', description: '', sessionMode: 'new', titleTemplate: '', pinnedSessionId: '', argsTemplate: '', exampleArgs: '', enabled: true })
  const { data: exposeSessionsData } = useQuery({
    queryKey: ['expose', 'sessions'],
    queryFn: listExposeSessions,
  })
  const sessionStatuses = exposeSessionsData?.sessions ?? []
  type SortKey = 'exposed'|'name'|'owner'|'desc'|'exposeName'|'exposeDesc'|'session'
  const [sortKey, setSortKey] = useState<SortKey | null>(null)
  const [sortDir, setSortDir] = useState<'asc'|'desc'>('asc')
  const [filterExposed, setFilterExposed] = useState<'all'|'exposed'|'unexposed'>('all')
  const [filterOwner, setFilterOwner] = useState<'all'|'builtin'|'global'|'project'>('all')
  const [colSearch, setColSearch] = useState({ name: '', owner: '', desc: '', exposeName: '', exposeDesc: '', sessionText: '' })

  const toggleSort = (k: SortKey) => {
    if (sortKey === k) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(k); setSortDir('asc') }
  }
  const SortIcon = ({ k }: { k: SortKey }) => {
    if (sortKey !== k) return <ArrowUpDown className="w-3 h-3 opacity-40" />
    return sortDir === 'asc' ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />
  }

  const exposedByCommand = useMemo(() => {
    const m = new Map<string, typeof exposed[number]>()
    for (const ex of exposed) m.set(ex.commandName, ex)
    return m
  }, [exposed])

  const filtered = useMemo(() => {
    let list = [...allCommands]
    const q = filter.trim().toLowerCase()
    if (q) list = list.filter(c => c.name.toLowerCase().includes(q) || (c.description ?? '').toLowerCase().includes(q) || (c.repoName ?? '').toLowerCase().includes(q))
    // per-header filters
    if (filterExposed !== 'all') {
      list = list.filter(c => {
        const ex = exposedByCommand.get(c.name)
        return filterExposed === 'exposed' ? !!ex : !ex
      })
    }
    if (filterOwner !== 'all') list = list.filter(c => c.scope === filterOwner)
    if (colSearch.name.trim()) {
      const qq = colSearch.name.trim().toLowerCase()
      list = list.filter(c => c.name.toLowerCase().includes(qq))
    }
    if (colSearch.owner.trim()) {
      const qq = colSearch.owner.trim().toLowerCase()
      list = list.filter(c => (c.repoName ?? c.scope).toLowerCase().includes(qq))
    }
    if (colSearch.desc.trim()) {
      const qq = colSearch.desc.trim().toLowerCase()
      list = list.filter(c => (c.description ?? '').toLowerCase().includes(qq))
    }
    if (colSearch.exposeName.trim() || colSearch.exposeDesc.trim() || colSearch.sessionText.trim()) {
      list = list.filter(c => {
        const ex = exposedByCommand.get(c.name)
        if (!ex) return false
        if (colSearch.exposeName.trim() && !ex.exposeName.toLowerCase().includes(colSearch.exposeName.trim().toLowerCase())) return false
        if (colSearch.exposeDesc.trim() && !ex.description.toLowerCase().includes(colSearch.exposeDesc.trim().toLowerCase())) return false
        if (colSearch.sessionText.trim()) {
          const hay = `${ex.sessionMode} ${ex.titleTemplate} ${ex.pinnedSessionId ?? ''}`.toLowerCase()
          if (!hay.includes(colSearch.sessionText.trim().toLowerCase())) return false
        }
        return true
      })
    }
    // sort
    if (sortKey) {
      list.sort((a,b) => {
        const exA = exposedByCommand.get(a.name)
        const exB = exposedByCommand.get(b.name)
        let va: string = '', vb: string = ''
        switch (sortKey) {
          case 'exposed': va = exA ? '1' : '0'; vb = exB ? '1' : '0'; break
          case 'name': va = a.name; vb = b.name; break
          case 'owner': va = a.repoName ?? a.scope; vb = b.repoName ?? b.scope; break
          case 'desc': va = a.description ?? ''; vb = b.description ?? ''; break
          case 'exposeName': va = exA?.exposeName ?? ''; vb = exB?.exposeName ?? ''; break
          case 'exposeDesc': va = exA?.description ?? ''; vb = exB?.description ?? ''; break
          case 'session': va = exA?.sessionMode ?? ''; vb = exB?.sessionMode ?? ''; break
        }
        const cmp = va.localeCompare(vb)
        return sortDir === 'asc' ? cmp : -cmp
      })
    }
    return list
  }, [allCommands, filter, filterExposed, filterOwner, colSearch, sortKey, sortDir, exposedByCommand])

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['expose', 'commands'] })
    queryClient.invalidateQueries({ queryKey: ['public', 'commands'] })
  }

  const createMut = useMutation({
    mutationFn: (c: Parameters<typeof createExposed>[0]) => createExposed(c),
    onSuccess: () => { invalidate() },
    onError: (e) => showToast.error(e instanceof Error ? e.message : 'Failed to expose'),
  })
  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Parameters<typeof updateExposed>[1] }) => updateExposed(id, data),
    onSuccess: () => invalidate(),
    onError: (e) => showToast.error(e instanceof Error ? e.message : 'Failed to update'),
  })
  // kept for future use (delete via dialog)
  void deleteExposed

  const toggle = (cmdName: string, cmdDesc: string, checked: boolean) => {
    const ex = exposedByCommand.get(cmdName)
    if (!ex && checked) {
      createMut.mutate({ commandName: cmdName, exposeName: cmdName, description: cmdDesc ?? '', enabled: true })
    } else if (ex && checked && !ex.enabled) {
      updateMut.mutate({ id: ex.id, data: { enabled: true } })
    } else if (ex && !checked && ex.enabled) {
      updateMut.mutate({ id: ex.id, data: { enabled: false } })
    } else if (ex && !checked && !ex.enabled) {
      // already draft, keep as draft (no-op)
    }
  }

  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text).catch(() => {})
    showToast.success('Copied')
  }

  const publicBase = useMemo(() => {
    const base = system ? `http://${system.backend.host === '0.0.0.0' ? 'localhost' : system.backend.host}:${system.backend.port}` : window.location.origin
    return `${base}/api/public/commands`
  }, [system])

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 bg-gradient-to-b from-background via-background to-background border-b border-border backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between py-2">
            <div className="flex items-center gap-2">
              <HeaderButton variant="ghost" size="icon" onClick={() => navigate('/')} className="h-8 w-8 shrink-0" title="홈으로">
                <Home className="w-4 h-4" />
              </HeaderButton>
              <h1 className="text-xl font-semibold bg-gradient-to-r from-foreground to-muted-foreground bg-clip-text text-transparent truncate">Expose Commands</h1>
            </div>
          </div>
        </div>
      </header>
      <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-4 overflow-auto">
        <DescPanel publicBase={publicBase} publicCount={publicData?.count ?? 0} system={system} onCopy={copy} open={descOpen} onToggle={() => setDescOpen(o => !o)} />

        <div className="flex items-center gap-2">
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter name / description / repo" className="h-8 max-w-sm text-sm" />
          <span className="text-xs text-muted-foreground">{filtered.length} / {allCommands.length} commands</span>
        </div>

        <div className="rounded-lg border overflow-hidden">
          <div className="overflow-auto" style={{ maxHeight: descOpen ? 'calc(100vh - 380px)' : 'calc(100vh - 280px)', minHeight: '200px', scrollbarGutter: 'stable' } as any}>
            <table className="w-full text-sm min-w-[900px]">
              <thead className="sticky top-0 bg-muted/80 backdrop-blur border-b text-xs text-muted-foreground">
                <tr>
                  <th className="px-2 py-1 text-center">
                    <button onClick={() => toggleSort('exposed')} className="inline-flex items-center gap-1 hover:text-foreground"><span>노출</span><SortIcon k="exposed" /></button>
                  </th>
                  <th className="text-left px-2 py-1">
                    <button onClick={() => toggleSort('name')} className="inline-flex items-center gap-1 hover:text-foreground"><span>커맨드</span><SortIcon k="name" /></button>
                  </th>
                  <th className="text-left px-2 py-1">
                    <button onClick={() => toggleSort('owner')} className="inline-flex items-center gap-1 hover:text-foreground"><span>소유</span><SortIcon k="owner" /></button>
                  </th>
                  <th className="text-left px-2 py-1">
                    <button onClick={() => toggleSort('desc')} className="inline-flex items-center gap-1 hover:text-foreground"><span>원본 설명</span><SortIcon k="desc" /></button>
                  </th>
                  <th className="text-left px-2 py-1">
                    <button onClick={() => toggleSort('exposeName')} className="inline-flex items-center gap-1 hover:text-foreground"><span>외부 이름</span><SortIcon k="exposeName" /></button>
                  </th>
                  <th className="text-left px-2 py-1">
                    <button onClick={() => toggleSort('exposeDesc')} className="inline-flex items-center gap-1 hover:text-foreground"><span>외부 설명</span><SortIcon k="exposeDesc" /></button>
                  </th>
                  <th className="text-left px-2 py-1">
                    <button onClick={() => toggleSort('session')} className="inline-flex items-center gap-1 hover:text-foreground"><span>세션</span><SortIcon k="session" /></button>
                  </th>
                  <th className="text-left px-2 py-1">세션명 템플릿 / 고정 세션</th>
                  <th className="px-2 py-1 text-center">편집</th>
                </tr>
                <tr className="bg-background/60">
                  <th className="px-1 py-1">
                    <select value={filterExposed} onChange={e => setFilterExposed(e.target.value as any)} className="h-6 w-full rounded border bg-background text-[11px] px-1">
                      <option value="all">전체</option>
                      <option value="exposed">노출만</option>
                      <option value="unexposed">미노출</option>
                    </select>
                  </th>
                  <th className="px-1 py-1">
                    <div className="relative">
                      <Search className="absolute left-1 top-1.5 w-3 h-3 opacity-40" />
                      <Input value={colSearch.name} onChange={e => setColSearch(s => ({ ...s, name: e.target.value }))} placeholder="검색" className="h-6 pl-5 text-[11px]" />
                    </div>
                  </th>
                  <th className="px-1 py-1">
                    <div className="flex gap-1">
                      <select value={filterOwner} onChange={e => setFilterOwner(e.target.value as any)} className="h-6 rounded border bg-background text-[11px] px-1 flex-1">
                        <option value="all">전체</option>
                        <option value="builtin">builtin</option>
                        <option value="global">global</option>
                        <option value="project">project</option>
                      </select>
                      <div className="relative flex-1 hidden lg:block">
                        <Input value={colSearch.owner} onChange={e => setColSearch(s => ({ ...s, owner: e.target.value }))} placeholder="레포 검색" className="h-6 text-[11px]" />
                      </div>
                    </div>
                  </th>
                  <th className="px-1 py-1">
                    <div className="relative">
                      <Search className="absolute left-1 top-1.5 w-3 h-3 opacity-40" />
                      <Input value={colSearch.desc} onChange={e => setColSearch(s => ({ ...s, desc: e.target.value }))} placeholder="검색" className="h-6 pl-5 text-[11px]" />
                    </div>
                  </th>
                  <th className="px-1 py-1">
                    <div className="relative">
                      <Search className="absolute left-1 top-1.5 w-3 h-3 opacity-40" />
                      <Input value={colSearch.exposeName} onChange={e => setColSearch(s => ({ ...s, exposeName: e.target.value }))} placeholder="검색" className="h-6 pl-5 text-[11px]" />
                    </div>
                  </th>
                  <th className="px-1 py-1">
                    <div className="relative">
                      <Search className="absolute left-1 top-1.5 w-3 h-3 opacity-40" />
                      <Input value={colSearch.exposeDesc} onChange={e => setColSearch(s => ({ ...s, exposeDesc: e.target.value }))} placeholder="검색" className="h-6 pl-5 text-[11px]" />
                    </div>
                  </th>
                  <th className="px-1 py-1">
                    <select value={colSearch.sessionText} onChange={e => setColSearch(s => ({ ...s, sessionText: e.target.value }))} className="h-6 w-full rounded border bg-background text-[11px] px-1 hidden">
                      <option value="">전체</option>
                    </select>
                    <div className="relative">
                      <Search className="absolute left-1 top-1.5 w-3 h-3 opacity-40" />
                      <Input value={colSearch.sessionText} onChange={e => setColSearch(s => ({ ...s, sessionText: e.target.value }))} placeholder="검색" className="h-6 pl-5 text-[11px]" />
                    </div>
                  </th>
                  <th className="px-1 py-1">
                    <span className="text-[11px] opacity-50">—</span>
                  </th>
                  <th className="px-1 py-1"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filtered.map((cmd) => {
                  const ex = exposedByCommand.get(cmd.name)
                  const checked = !!ex?.enabled
                  const isDraft = !!ex && !ex.enabled
                  return (
                    <tr key={cmd.name} className={`hover:bg-muted/20 ${checked ? 'bg-primary/5' : isDraft ? 'bg-amber-500/5' : ''}`}>
                      <td className="px-2 py-1.5 text-center">
                        <Checkbox checked={checked} onCheckedChange={(v) => toggle(cmd.name, cmd.description ?? '', !!v)} />
                      </td>
                      <td className="px-2 py-1.5 font-mono text-xs font-medium">/{cmd.name}</td>
                      <td className="px-2 py-1.5">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] border ${cmd.scope==='builtin'?'bg-blue-500/10 border-blue-500/30 text-blue-600':cmd.scope==='global'?'bg-purple-500/10 border-purple-500/30 text-purple-600':'bg-amber-500/10 border-amber-500/30 text-amber-700'}`} title={cmd.localPath ?? cmd.scope}>
                          {cmd.scope==='builtin'?'builtin':cmd.scope==='global'?'global':cmd.repoName ?? 'project'}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-xs text-muted-foreground truncate max-w-[200px]" title={cmd.description ?? ''}>{cmd.description || '-'}</td>
                      <td className="px-2 py-1.5 text-xs font-mono truncate max-w-[140px]" title={ex?.exposeName ?? ''}>{ex ? ex.exposeName : <span className="text-muted-foreground/50">—</span>}</td>
                      <td className="px-2 py-1.5 text-xs truncate max-w-[200px]" title={ex?.description ?? ''}>{ex ? (ex.description || <span className="text-muted-foreground/50">—</span>) : <span className="text-muted-foreground/50">—</span>}</td>
                      <td className="px-2 py-1.5 text-xs">{ex ? <span className={`px-1.5 py-0.5 rounded text-[10px] border ${ex.sessionMode==='new'?'bg-green-500/10 border-green-500/30 text-green-700':'bg-amber-500/10 border-amber-500/30 text-amber-700'}`}>{ex.sessionMode==='new'?'새 세션':'기존 세션'}</span> : <span className="text-muted-foreground/50">—</span>}</td>
                      <td className="px-2 py-1.5 text-xs font-mono truncate max-w-[180px]" title={ex ? `${ex.titleTemplate ?? ''} ${ex.pinnedSessionId ?? ''}` : ''}>{ex ? (ex.titleTemplate || ex.pinnedSessionId ? `${ex.titleTemplate ?? ''}${ex.titleTemplate && ex.pinnedSessionId ? ' / ' : ''}${ex.pinnedSessionId ?? ''}` : <span className="text-muted-foreground/50">—</span>) : <span className="text-muted-foreground/50">—</span>}</td>
                      <td className="px-2 py-1.5 text-center">
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => {
                          if (ex) { setEditingEx(ex); setEditForm({ exposeName: ex.exposeName, description: ex.description ?? '', sessionMode: ex.sessionMode ?? 'new', titleTemplate: ex.titleTemplate ?? '', pinnedSessionId: ex.pinnedSessionId ?? '', argsTemplate: (ex as any).argsTemplate ?? '', exampleArgs: (ex as any).exampleArgs ?? '', enabled: ex.enabled }) }
                          else { const draft: any = { id: 0, commandName: cmd.name, exposeName: cmd.name, description: cmd.description ?? '', sessionMode: 'new', titleTemplate: '', pinnedSessionId: '', argsTemplate: '', exampleArgs: '', enabled: false }; setEditingEx(draft); setEditForm({ exposeName: cmd.name, description: cmd.description ?? '', sessionMode: 'new', titleTemplate: '', pinnedSessionId: '', argsTemplate: '', exampleArgs: '', enabled: false }) }
                        }} title="편집"><Pencil className="w-3.5 h-3.5" /></Button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="px-3 py-2 border-t text-xs text-muted-foreground bg-muted/10">
            체크 = 노출(초록) / 미체크지만 행이 있으면 draft(호박) · 편집은 미노출 상태에서도 저장 가능(저장 시 draft로 보관, 체크하면 노출) · 원본 설명이 기본값
          </div>
        </div>
      </div>

      <Dialog open={!!editingEx} onOpenChange={(o) => !o && setEditingEx(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>편집: /{editingEx?.commandName} → {editingEx?.exposeName}</DialogTitle>
          </DialogHeader>
          {editingEx && (
            <div className="space-y-4 max-h-[65vh] overflow-auto pr-1">
              <div className="space-y-3">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">기본 정보</h4>
                <div className="flex items-center justify-between rounded border p-2 bg-muted/20">
                  <Label className="text-xs">노출</Label>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted-foreground">{editForm.enabled ? '노출' : '미노출(draft)'}</span>
                    <Checkbox checked={editForm.enabled} onCheckedChange={v => setEditForm(s => ({ ...s, enabled: !!v }))} />
                  </div>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">외부 이름</Label>
                  <Input value={editForm.exposeName} onChange={e => setEditForm(s => ({ ...s, exposeName: e.target.value }))} placeholder="exposeName" className="font-mono text-sm" />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">외부 설명</Label>
                  <Textarea value={editForm.description} onChange={e => setEditForm(s => ({ ...s, description: e.target.value }))} placeholder="외부에 보이는 설명" className="text-sm min-h-[70px]" />
                </div>
              </div>

              <div className="border-t my-2" />

              <div className="space-y-3">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">세션 설정</h4>
                <div className="space-y-1">
                  <Label className="text-xs">세션 전략</Label>
                  <Select value={editForm.sessionMode} onValueChange={v => setEditForm(s => ({ ...s, sessionMode: v as 'new'|'reuse' }))}>
                    <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="new">새 세션 (항상 신규)</SelectItem>
                      <SelectItem value="reuse">기존 세션</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">세션명 템플릿</Label>
                  <Input value={editForm.titleTemplate} onChange={e => setEditForm(s => ({ ...s, titleTemplate: e.target.value }))} placeholder="[EXPOSE] {exposeName} {date}" className="font-mono text-sm" />
                  <p className="text-[11px] text-muted-foreground">변수: {"{exposeName} {commandName} {date} {time}"}</p>
                </div>
                {editForm.sessionMode === 'reuse' && (
                  <div className="space-y-1">
                    <Label className="text-xs">고정 세션 (세션명 포함 목록에서 선택)</Label>
                    <Select value={editForm.pinnedSessionId || '__none__'} onValueChange={v => setEditForm(s => ({ ...s, pinnedSessionId: v === '__none__' ? '' : v }))}>
                      <SelectTrigger className="h-8 text-sm font-mono"><SelectValue placeholder="세션 선택" /></SelectTrigger>
                      <SelectContent className="max-h-[240px]">
                        <SelectItem value="__none__">없음 (호출 시 sessionId 또는 신규)</SelectItem>
                        {sessionStatuses.slice(0, 80).map(ss => (
                          <SelectItem key={ss.sessionId} value={ss.sessionId} className="font-mono text-xs">
                            {ss.title} · {ss.sessionId.slice(0,8)} · {ss.repoName} · {ss.status}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input value={editForm.pinnedSessionId} onChange={e => setEditForm(s => ({ ...s, pinnedSessionId: e.target.value }))} placeholder="또는 직접 sessionId 입력" className="font-mono text-sm h-7 mt-1" />
                  </div>
                )}
              </div>

              <div className="border-t my-2" />

              <div className="space-y-3">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">호출 설정</h4>
                <div className="space-y-1">
                  <Label className="text-xs">인자 템플릿 (호출 시 args에 적용, 비우면 그대로 전달)</Label>
                  <Input value={editForm.argsTemplate} onChange={e => setEditForm(s => ({ ...s, argsTemplate: e.target.value }))} placeholder='예: --prompt "{args}" 또는 {args} 그대로' className="font-mono text-sm" />
                  <p className="text-[11px] text-muted-foreground">{"{args}"} 가 호출 시 args로 치환됨. 비우면 "/command args" 형태.</p>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">사용 예시 (문서용)</Label>
                  <Input value={editForm.exampleArgs} onChange={e => setEditForm(s => ({ ...s, exampleArgs: e.target.value }))} placeholder='예: hello world / --file src/app.ts' className="font-mono text-sm" />
                  <p className="text-[11px] text-muted-foreground">GET /api/public/commands에 노출되어 외부 문서에 표시됨.</p>
                </div>
              </div>

              <div className="border-t my-2" />

              <div className="space-y-1">
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">API</h4>
                <div className="rounded border bg-muted/30 p-2 text-xs font-mono flex items-center justify-between gap-2">
                  <span className="truncate">POST /api/public/commands/{editingEx.exposeName}/run</span>
                  <Button size="sm" variant="outline" className="h-6 text-xs shrink-0" onClick={() => copy(`${window.location.origin}/api/public/commands/${editingEx.exposeName}/run`)}><Copy className="w-3 h-3" /> Copy</Button>
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditingEx(null)}>취소</Button>
            <Button onClick={() => {
              if (!editingEx) return
              if ((editingEx as any).id === 0) {
                const cmdName = (editingEx as any).commandName
                createMut.mutate({ commandName: cmdName, exposeName: editForm.exposeName.trim() || cmdName, description: editForm.description, enabled: editForm.enabled, sessionMode: editForm.sessionMode, titleTemplate: editForm.titleTemplate, pinnedSessionId: editForm.pinnedSessionId || undefined, argsTemplate: editForm.argsTemplate, exampleArgs: editForm.exampleArgs }, { onSuccess: () => setEditingEx(null) })
                return
              }
              const payload: any = {}
              if (editForm.exposeName.trim() && editForm.exposeName.trim() !== editingEx.exposeName) payload.exposeName = editForm.exposeName.trim()
              if (editForm.description !== editingEx.description) payload.description = editForm.description
              if (editForm.enabled !== editingEx.enabled) payload.enabled = editForm.enabled
              if (editForm.sessionMode !== editingEx.sessionMode) payload.sessionMode = editForm.sessionMode
              if (editForm.titleTemplate !== (editingEx.titleTemplate ?? '')) payload.titleTemplate = editForm.titleTemplate
              if ((editForm.pinnedSessionId ?? '') !== (editingEx.pinnedSessionId ?? '')) payload.pinnedSessionId = editForm.pinnedSessionId || null
              if (editForm.argsTemplate !== ((editingEx as any).argsTemplate ?? '')) payload.argsTemplate = editForm.argsTemplate
              if (editForm.exampleArgs !== ((editingEx as any).exampleArgs ?? '')) payload.exampleArgs = editForm.exampleArgs
              if (Object.keys(payload).length === 0) { setEditingEx(null); return }
              updateMut.mutate({ id: editingEx.id, data: payload }, { onSuccess: () => setEditingEx(null) })
            }}>{(editingEx as any)?.id === 0 ? (editForm.enabled ? '노출 생성' : 'draft 저장') : '저장'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function DescPanel({ publicBase, publicCount, system, onCopy, open, onToggle }: { publicBase: string; publicCount: number; system: any; onCopy: (t: string) => void; open: boolean; onToggle: () => void }) {
  return (
    <div className="rounded-lg border bg-muted/20">
      <button onClick={onToggle} className="w-full flex items-center justify-between p-3 text-xs hover:bg-muted/30">
        <span className="inline-flex items-center gap-1.5 font-medium"><Globe className="w-3.5 h-3.5" /> Public (MCP-like) · {publicCount} 노출됨 {system ? `· v${system.version} :${system.backend.port}` : ''}</span>
        <span className="inline-flex items-center gap-1 text-muted-foreground">{open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />} {open ? '접기' : '펼치기'}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-mono px-2 py-1 rounded bg-background border">GET {publicBase}</span>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onCopy(publicBase)}><Copy className="w-3 h-3" /> Copy</Button>
          </div>
          <div className="text-xs font-mono bg-background border rounded p-2 space-y-1">
            <div>호출: <span className="text-primary">POST {publicBase}/:exposeName/run</span></div>
            <div className="text-muted-foreground">body: {"{ repoId?: number, directory?: string, args?: string, sessionId?: string }"} — 체크된 것만 노출, 미체크는 404</div>
            <div className="text-muted-foreground">세션: <span className="text-foreground">새 세션</span> = 항상 신규 세션 생성(제목 템플릿 적용), <span className="text-foreground">기존 세션</span> = 고정 세션 또는 호출 시 sessionId 재활용, 없으면 신규</div>
            <div className="text-muted-foreground">제목 템플릿 변수: {"{exposeName} {commandName} {date} {time}"} 예: "[EXPOSE] {"{exposeName}"} - {"{date}"}"</div>
            <div className="text-muted-foreground">예: curl -X POST {publicBase}/my-plan/run -H "Content-Type: application/json" -d '{"{ \"repoId\":1, \"args\":\"hello\" }"}'</div>
          </div>
        </div>
      )}
    </div>
  )
}
