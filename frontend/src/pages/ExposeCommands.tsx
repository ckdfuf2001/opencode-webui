import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { listExposed, createExposed, updateExposed, deleteExposed, listPublicCommands } from '@/api/expose'
import { useCommands } from '@/hooks/useCommands'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'
import { showToast } from '@/lib/toast'
import { Copy, Plug, Globe } from 'lucide-react'
import { getSystemInfo } from '@/api/system'
import { Header } from '@/components/layout/Header'

export function ExposeCommands() {
  const queryClient = useQueryClient()
  const { data: exposed = [] } = useQuery({ queryKey: ['expose', 'commands'], queryFn: listExposed })
  const { data: publicData } = useQuery({ queryKey: ['public', 'commands'], queryFn: listPublicCommands })
  const { data: system } = useQuery({ queryKey: ['system', 'info'], queryFn: getSystemInfo })
  const { commands, loading: cmdLoading } = useCommands(null)

  const [filter, setFilter] = useState('')
  const [edits, setEdits] = useState<Record<number, { exposeName: string; description: string }>>({})

  const exposedByCommand = useMemo(() => {
    const m = new Map<string, typeof exposed[number]>()
    for (const ex of exposed) m.set(ex.commandName, ex)
    return m
  }, [exposed])

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return commands
    return commands.filter(c => c.name.toLowerCase().includes(q) || (c.description ?? '').toLowerCase().includes(q))
  }, [commands, filter])

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
        <div className="rounded-lg border p-3 bg-muted/20 flex flex-wrap items-center gap-3 text-xs">
          <span className="inline-flex items-center gap-1.5 font-medium"><Globe className="w-3.5 h-3.5" /> Public</span>
          <span className="font-mono px-2 py-1 rounded bg-background border">GET {publicBase}</span>
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => copy(publicBase)}><Copy className="w-3 h-3" /> Copy</Button>
          <span className="text-muted-foreground">· POST {publicBase}/:exposeName/run {"{ repoId, args }"} · {publicData?.count ?? 0} enabled</span>
          {system && <span className="text-muted-foreground">· v{system.version} :{system.backend.port} / opencode :{system.opencode.port}</span>}
        </div>

        <div className="flex items-center gap-2">
          <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter name / description" className="h-8 max-w-sm text-sm" />
          <span className="text-xs text-muted-foreground">{filtered.length} / {commands.length} commands {cmdLoading ? '(loading…)' : ''}</span>
          <span className="ml-auto text-xs text-muted-foreground flex items-center gap-1"><Plug className="w-3 h-3" /> /expose</span>
        </div>

        <div className="rounded-lg border overflow-hidden">
          <div className="max-h-[70vh] overflow-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted/50 backdrop-blur border-b text-xs text-muted-foreground">
                <tr>
                  <th className="w-10 px-2 py-2 text-center">노출</th>
                  <th className="text-left px-2 py-2 w-[160px]">커맨드</th>
                  <th className="text-left px-2 py-2">원본 설명</th>
                  <th className="text-left px-2 py-2 w-[160px]">외부 이름</th>
                  <th className="text-left px-2 py-2 w-[260px]">외부 설명 (수정 가능)</th>
                  <th className="w-16 px-2 py-2 text-center">Active</th>
                  <th className="w-20 px-2 py-2 text-center">복사</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {filtered.map((cmd) => {
                  const ex = exposedByCommand.get(cmd.name)
                  const checked = !!ex
                  const edit = ex ? edits[ex.id] : undefined
                  const exposeNameVal = edit?.exposeName ?? ex?.exposeName ?? ''
                  const descVal = edit?.description ?? ex?.description ?? ''
                  return (
                    <tr key={cmd.name} className={`hover:bg-muted/20 ${checked ? 'bg-primary/5' : ''}`}>
                      <td className="px-2 py-1.5 text-center">
                        <Checkbox checked={checked} onCheckedChange={(v) => toggle(cmd.name, cmd.description ?? '', !!v)} />
                      </td>
                      <td className="px-2 py-1.5 font-mono text-xs font-medium">/{cmd.name}</td>
                      <td className="px-2 py-1.5 text-xs text-muted-foreground truncate max-w-[280px]" title={cmd.description ?? ''}>{cmd.description || '-'}</td>
                      <td className="px-2 py-1.5">
                        {ex ? (
                          <Input
                            value={exposeNameVal}
                            onChange={(e) => setEdits(prev => ({ ...prev, [ex.id]: { exposeName: e.target.value, description: prev[ex.id]?.description ?? ex.description } }))}
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
                            onChange={(e) => setEdits(prev => ({ ...prev, [ex.id]: { exposeName: prev[ex.id]?.exposeName ?? ex.exposeName, description: e.target.value } }))}
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
                        ) : <span className="text-xs text-muted-foreground/50 truncate max-w-[240px] block" title={cmd.description ?? ''}>{cmd.description ?? '-'}</span>}
                      </td>
                      <td className="px-2 py-1.5 text-center">
                        {ex ? <Switch checked={ex.enabled} onCheckedChange={(v) => updateMut.mutate({ id: ex.id, data: { enabled: v } })} /> : <span className="text-xs text-muted-foreground/30">—</span>}
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
            체크 = 노출, 외부 이름/외부 설명은 블러 시 저장 · Active 끄면 public 목록에서 제외 · 원본 설명이 기본값으로 들어가고 수정해 노출할 수 있음
          </div>
        </div>
      </div>
    </div>
  )
}
