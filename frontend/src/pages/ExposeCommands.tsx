import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { listExposed, createExposed, updateExposed, deleteExposed, listPublicCommands, listAvailableCommands } from '@/api/expose'
import { useCommands } from '@/hooks/useCommands'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { showToast } from '@/lib/toast'
import { Copy, Plug, Globe, ArrowUp, ArrowDown, ArrowUpDown, Search } from 'lucide-react'
import { getSystemInfo } from '@/api/system'
import { Header } from '@/components/layout/Header'

export function ExposeCommands() {
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
  const [edits, setEdits] = useState<Record<number, { exposeName: string; description: string; sessionMode: 'new'|'reuse'; titleTemplate: string; pinnedSessionId: string }>>({})
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
    mutationFn: (c: { commandName: string; exposeName?: string; description?: string }) => createExposed(c),
    onSuccess: () => { invalidate() },
    onError: (e) => showToast.error(e instanceof Error ? e.message : 'Failed to expose'),
  })
  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Parameters<typeof updateExposed>[1] }) => updateExposed(id, data),
    onSuccess: () => invalidate(),
    onError: (e) => showToast.error(e instanceof Error ? e.message : 'Failed to update'),
  })
  const deleteMut = useMutation({
    mutationFn: deleteExposed,
    onSuccess: () => invalidate(),
    onError: (e) => showToast.error(e instanceof Error ? e.message : 'Failed to delete'),
  })

  const toggle = (cmdName: string, cmdDesc: string, checked: boolean) => {
    const ex = exposedByCommand.get(cmdName)
    if (checked && !ex) {
      createMut.mutate({ commandName: cmdName, exposeName: cmdName, description: cmdDesc ?? '' })
    } else if (!checked && ex) {
      deleteMut.mutate(ex.id)
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
      <Header title="Expose Commands" backTo="/" />
      <div className="max-w-6xl mx-auto p-4 sm:p-6 space-y-4">
        <div className="rounded-lg border p-3 bg-muted/20 space-y-2">
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <span className="inline-flex items-center gap-1.5 font-medium"><Globe className="w-3.5 h-3.5" /> Public (MCP-like)</span>
            <span className="font-mono px-2 py-1 rounded bg-background border">GET {publicBase}</span>
            <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => copy(publicBase)}><Copy className="w-3 h-3" /> Copy</Button>
            <span className="text-muted-foreground">· {publicData?.count ?? 0} 노출됨</span>
            {system && <span className="text-muted-foreground">· v{system.version} :{system.backend.port}</span>}
          </div>
          <div className="text-xs font-mono bg-background border rounded p-2 space-y-1">
            <div>호출: <span className="text-primary">POST {publicBase}/:exposeName/run</span></div>
            <div className="text-muted-foreground">body: {"{ repoId?: number, directory?: string, args?: string, sessionId?: string }"} — 체크된 것만 노출, 미체크는 404</div>
            <div className="text-muted-foreground">세션: <span className="text-foreground">새 세션</span> = 항상 신규 세션 생성(제목 템플릿 적용), <span className="text-foreground">재활용</span> = pinned 세션 또는 호출 시 sessionId 재활용, 없으면 신규</div>
            <div className="text-muted-foreground">제목 템플릿 변수: {"{exposeName} {commandName} {date} {time}"} 예: "[EXPOSE] {"{exposeName}"} - {"{date}"}"</div>
            <div className="text-muted-foreground">예: curl -X POST {publicBase}/my-plan/run -H "Content-Type: application/json" -d '{"{ \"repoId\":1, \"args\":\"hello\" }"}'</div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter name / description / repo" className="h-8 max-w-sm text-sm" />
          <span className="text-xs text-muted-foreground">{filtered.length} / {allCommands.length} commands</span>
          <span className="ml-auto text-xs text-muted-foreground flex items-center gap-1"><Plug className="w-3 h-3" /> /expose</span>
        </div>

        <div className="rounded-lg border overflow-hidden flex flex-col">
          <div className="overflow-auto max-h-[60vh] overscroll-contain" style={{ scrollbarGutter: 'stable' } as any}>
            <table className="w-full text-sm">
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
                  <th className="px-2 py-1 text-center">복사</th>
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
                  const checked = !!ex
                  const edit = ex ? edits[ex.id] : undefined
                  const exposeNameVal = edit?.exposeName ?? ex?.exposeName ?? ''
                  const descVal = edit?.description ?? ex?.description ?? ''
                  const modeVal = edit?.sessionMode ?? ex?.sessionMode ?? 'new'
                  const titleVal = edit?.titleTemplate ?? ex?.titleTemplate ?? ''
                  const pinnedVal = edit?.pinnedSessionId ?? ex?.pinnedSessionId ?? ''
                  const setEdit = (patch: Partial<{ exposeName: string; description: string; sessionMode: 'new'|'reuse'; titleTemplate: string; pinnedSessionId: string }>) => {
                    if (!ex) return
                    setEdits(prev => ({ ...prev, [ex.id]: { exposeName: prev[ex.id]?.exposeName ?? ex.exposeName, description: prev[ex.id]?.description ?? ex.description, sessionMode: prev[ex.id]?.sessionMode ?? ex.sessionMode ?? 'new', titleTemplate: prev[ex.id]?.titleTemplate ?? ex.titleTemplate ?? '', pinnedSessionId: prev[ex.id]?.pinnedSessionId ?? ex.pinnedSessionId ?? '', ...patch } }))
                  }
                  return (
                    <tr key={cmd.name} className={`hover:bg-muted/20 ${checked ? 'bg-primary/5' : ''}`}>
                      <td className="px-2 py-1.5 text-center">
                        <Checkbox checked={checked} onCheckedChange={(v) => toggle(cmd.name, cmd.description ?? '', !!v)} />
                      </td>
                      <td className="px-2 py-1.5 font-mono text-xs font-medium">/{cmd.name}</td>
                      <td className="px-2 py-1.5">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] border ${cmd.scope==='builtin'?'bg-blue-500/10 border-blue-500/30 text-blue-600':cmd.scope==='global'?'bg-purple-500/10 border-purple-500/30 text-purple-600':'bg-amber-500/10 border-amber-500/30 text-amber-700'}`} title={cmd.localPath ?? cmd.scope}>
                          {cmd.scope==='builtin'?'builtin':cmd.scope==='global'?'global':cmd.repoName ?? 'project'}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-xs text-muted-foreground truncate max-w-[220px]" title={cmd.description ?? ''}>{cmd.description || '-'}</td>
                      <td className="px-2 py-1.5">
                        {ex ? (
                          <Input
                            value={exposeNameVal}
                            onChange={(e) => setEdit({ exposeName: e.target.value })}
                            onBlur={() => {
                              const cur = edits[ex.id]
                              if (!cur) return
                              if (cur.exposeName.trim() && cur.exposeName.trim() !== ex.exposeName) {
                                updateMut.mutate({ id: ex.id, data: { exposeName: cur.exposeName.trim() } })
                              }
                            }}
                            className="h-7 text-xs font-mono"
                            placeholder={cmd.name}
                          />
                        ) : <span className="text-xs text-muted-foreground/50">—</span>}
                      </td>
                      <td className="px-2 py-1.5">
                        {ex ? (
                          <Input
                            value={descVal}
                            onChange={(e) => setEdit({ description: e.target.value })}
                            onBlur={() => {
                              const cur = edits[ex.id]
                              if (!cur) return
                              if (cur.description !== ex.description) {
                                updateMut.mutate({ id: ex.id, data: { description: cur.description } })
                              }
                            }}
                            className="h-7 text-xs"
                            placeholder={cmd.description ?? '설명'}
                          />
                        ) : <span className="text-xs text-muted-foreground/50 truncate max-w-[180px] block" title={cmd.description ?? ''}>{cmd.description ?? '-'}</span>}
                      </td>
                      <td className="px-2 py-1.5">
                        {ex ? (
                          <select value={modeVal} onChange={(e) => { const v = e.target.value as 'new'|'reuse'; setEdit({ sessionMode: v }); updateMut.mutate({ id: ex.id, data: { sessionMode: v } }) }} className="h-7 w-full rounded-md border border-input bg-background text-xs px-1">
                            <option value="new">새 세션</option>
                            <option value="reuse">재활용</option>
                          </select>
                        ) : <span className="text-xs text-muted-foreground/50">—</span>}
                      </td>
                      <td className="px-2 py-1.5">
                        {ex ? (
                          <div className="flex flex-col gap-1">
                            <Input
                              value={titleVal}
                              onChange={(e) => setEdit({ titleTemplate: e.target.value })}
                              onBlur={() => {
                                const cur = edits[ex.id]
                                if (!cur) return
                                if (cur.titleTemplate !== ex.titleTemplate) updateMut.mutate({ id: ex.id, data: { titleTemplate: cur.titleTemplate } })
                              }}
                              className="h-7 text-xs font-mono"
                              placeholder={modeVal === 'new' ? '[EXPOSE]{exposeName} {date}' : '새 세션 시 제목'}
                              title="{exposeName} {commandName} {date} {time} 치환"
                            />
                            {modeVal === 'reuse' && (
                              <Input
                                value={pinnedVal}
                                onChange={(e) => setEdit({ pinnedSessionId: e.target.value })}
                                onBlur={() => {
                                  const cur = edits[ex.id]
                                  if (!cur) return
                                  if ((cur.pinnedSessionId ?? '') !== (ex.pinnedSessionId ?? '')) updateMut.mutate({ id: ex.id, data: { pinnedSessionId: cur.pinnedSessionId || null } as any })
                                }}
                                className="h-7 text-xs font-mono"
                                placeholder="고정 sessionId (선택)"
                              />
                            )}
                          </div>
                        ) : <span className="text-xs text-muted-foreground/50">—</span>}
                      </td>
                      <td className="px-2 py-1.5 text-center">
                        {ex ? <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => copy(`${window.location.origin}/api/public/commands/${ex.exposeName}/run`)} title="Copy run URL"><Copy className="w-3.5 h-3.5" /></Button> : null}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <div className="px-3 py-2 border-t text-xs text-muted-foreground bg-muted/10">
            체크 = 노출 (체크된 것만 GET /api/public/commands에 포함, 호출은 POST /api/public/commands/:exposeName/run) · 외부 이름/설명 블러 시 저장 · 원본 설명이 기본값
          </div>
        </div>
      </div>
    </div>
  )
}
