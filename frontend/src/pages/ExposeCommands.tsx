import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { listExposed, createExposed, updateExposed, deleteExposed, listPublicCommands } from '@/api/expose'
import { useCommands } from '@/hooks/useCommands'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { showToast } from '@/lib/toast'
import { Copy, Trash2, Plug, Globe, Plus } from 'lucide-react'
import { getSystemInfo } from '@/api/system'

export function ExposeCommands() {
  const queryClient = useQueryClient()
  const { data: exposed = [], isLoading } = useQuery({ queryKey: ['expose', 'commands'], queryFn: listExposed })
  const { data: publicData } = useQuery({ queryKey: ['public', 'commands'], queryFn: listPublicCommands })
  const { data: system } = useQuery({ queryKey: ['system', 'info'], queryFn: getSystemInfo })
  const { commands } = useCommands(null)

  const [form, setForm] = useState({ commandName: '', exposeName: '', description: '' })
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editDesc, setEditDesc] = useState('')
  const [editExpose, setEditExpose] = useState('')

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['expose', 'commands'] })
    queryClient.invalidateQueries({ queryKey: ['public', 'commands'] })
  }

  const createMut = useMutation({
    mutationFn: () => createExposed({ commandName: form.commandName.trim(), exposeName: form.exposeName.trim() || undefined, description: form.description.trim() || undefined }),
    onSuccess: () => { showToast.success('Exposed'); setForm({ commandName: '', exposeName: '', description: '' }); invalidate() },
    onError: (e) => showToast.error(e instanceof Error ? e.message : 'Failed to expose'),
  })

  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Parameters<typeof updateExposed>[1] }) => updateExposed(id, data),
    onSuccess: () => { showToast.success('Updated'); setEditingId(null); invalidate() },
    onError: (e) => showToast.error(e instanceof Error ? e.message : 'Failed to update'),
  })

  const deleteMut = useMutation({
    mutationFn: deleteExposed,
    onSuccess: () => { showToast.success('Deleted'); invalidate() },
    onError: (e) => showToast.error(e instanceof Error ? e.message : 'Failed to delete'),
  })

  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text).catch(() => {})
    showToast.success('Copied')
  }

  const publicUrl = useMemo(() => {
    const base = system ? `http://${system.backend.host === '0.0.0.0' ? 'localhost' : system.backend.host}:${system.backend.port}` : ''
    return base ? `${base}/api/public/commands` : '/api/public/commands'
  }, [system])

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-xl font-bold flex items-center gap-2"><Plug className="w-5 h-5" /> Expose Commands (MCP-like)</h1>
        <p className="text-sm text-muted-foreground mt-1">선택한 커맨드를 외부에서 MCP처럼 호출할 수 있도록 노출합니다. exposeName은 외부에서 보이는 이름, description은 외부 문서에 표시됩니다.</p>
      </div>

      <div className="rounded-lg border p-4 bg-muted/20 space-y-3">
        <h2 className="text-sm font-semibold flex items-center gap-1.5"><Globe className="w-4 h-4" /> Public discovery</h2>
        <div className="flex items-center gap-2 text-xs font-mono">
          <span className="px-2 py-1 rounded bg-background border">GET {publicUrl}</span>
          <Button size="sm" variant="outline" onClick={() => copy(publicUrl)}><Copy className="w-3 h-3" /> Copy</Button>
        </div>
        <div className="text-xs text-muted-foreground">예: <span className="font-mono">POST {publicUrl.replace('/commands', '/commands/my-expose/run')}  {"{ repoId: 1, args: \"hello\" }"}</span></div>
        {publicData && <div className="text-xs text-muted-foreground">{publicData.count} enabled public commands</div>}
        {system && <div className="text-xs text-muted-foreground">Backend v{system.version} · port {system.backend.port} · opencode {system.opencode.port} ({system.opencode.healthy ? 'healthy' : 'down'})</div>}
      </div>

      <div className="rounded-lg border p-4 space-y-3">
        <h2 className="text-sm font-semibold flex items-center gap-1.5"><Plus className="w-4 h-4" /> New expose</h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <div>
            <label className="text-xs text-muted-foreground">Command *</label>
            <Input list="expose-cmd-list" value={form.commandName} onChange={(e) => setForm({ ...form, commandName: e.target.value })} placeholder="e.g. plan" />
            <datalist id="expose-cmd-list">{commands.map((c) => <option key={c.name} value={c.name} />)}</datalist>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Expose name (외부 이름)</label>
            <Input value={form.exposeName} onChange={(e) => setForm({ ...form, exposeName: e.target.value })} placeholder="default = commandName" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Description</label>
            <Input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="외부 설명" />
          </div>
        </div>
        <Button size="sm" onClick={() => createMut.mutate()} disabled={!form.commandName.trim() || createMut.isPending}>Expose</Button>
      </div>

      <div className="rounded-lg border">
        <div className="px-4 py-2 border-b text-sm font-semibold">Exposed list ({exposed.length})</div>
        {isLoading ? <div className="p-4 text-sm text-muted-foreground">Loading...</div> : exposed.length === 0 ? <div className="p-4 text-sm text-muted-foreground">No exposed commands yet.</div> : (
          <div className="divide-y">
            {exposed.map((ex) => (
              <div key={ex.id} className="p-3 flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  {editingId === ex.id ? (
                    <div className="flex flex-col gap-2">
                      <Input value={editExpose} onChange={(e) => setEditExpose(e.target.value)} placeholder="exposeName" className="h-7 text-xs" />
                      <Input value={editDesc} onChange={(e) => setEditDesc(e.target.value)} placeholder="description" className="h-7 text-xs" />
                      <div className="flex gap-1">
                        <Button size="sm" className="h-7 text-xs" onClick={() => updateMut.mutate({ id: ex.id, data: { exposeName: editExpose.trim() || undefined, description: editDesc } })}>Save</Button>
                        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setEditingId(null)}>Cancel</Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="text-sm font-mono font-medium truncate">/{ex.commandName} → <span className="text-primary">{ex.exposeName}</span> <span className={`ml-1 px-1 py-0.5 rounded text-[10px] border ${ex.enabled ? 'bg-green-500/10 border-green-500/30 text-green-600' : 'bg-muted border-border'}`}>{ex.enabled ? 'enabled' : 'disabled'}</span></div>
                      <div className="text-xs text-muted-foreground truncate">{ex.description || 'No description'}</div>
                      <div className="text-[11px] font-mono text-muted-foreground mt-1">GET /api/public/commands / POST /api/public/commands/{ex.exposeName}/run</div>
                    </>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Switch checked={ex.enabled} onCheckedChange={(v) => updateMut.mutate({ id: ex.id, data: { enabled: v } })} />
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => { setEditingId(ex.id); setEditExpose(ex.exposeName); setEditDesc(ex.description) }}>Edit</Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => copy(`${window.location.origin}/api/public/commands/${ex.exposeName}/run`)} title="Copy run URL"><Copy className="w-3.5 h-3.5" /></Button>
                  <Button size="icon" variant="ghost" className="h-7 w-7 text-destructive" onClick={() => deleteMut.mutate(ex.id)}><Trash2 className="w-3.5 h-3.5" /></Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
