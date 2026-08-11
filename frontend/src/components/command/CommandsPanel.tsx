import { useEffect, useMemo, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Terminal,
  Loader2,
  CheckCircle2,
  AlertCircle,
  X,
  History,
  Search,
  Box,
  Globe,
  Folder,
  ChevronDown,
  ChevronRight,
  Wrench,
  Plus,
  CornerDownLeft,
  Trash2,
  Edit,
  Puzzle,
  Bot,
  Server,
  Shield,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useMessages, useSessions } from '@/hooks/useOpenCode'
import { useCommandRuns, type CommandRunStart } from '@/stores/commandRunsStore'
import { CreateCommandDialog, type RegistryEditTarget } from '@/components/command/CreateCommandDialog'
import { useCommands, type CommandScope, type CommandWithScope } from '@/hooks/useCommands'
import { collectDescendantIDs } from '@/hooks/usePermissionRequests'
import { listRepos } from '@/api/repos'
import { createOpenCodeClient } from '@/api/opencode'
import { registryApi, type RegistryListItem, type RegistryType } from '@/api/registry'
import { settingsApi } from '@/api/settings'
import { DeleteDialog } from '@/components/ui/delete-dialog'
import { showToast } from '@/lib/toast'
import type { MessageWithParts, Part } from '@/api/types'

function commandNeedsArgs(command: CommandWithScope): boolean {
  const t = command.template ?? ''
  return /\$(?:ARGUMENTS|\d+)/.test(t)
}

interface CommandsPanelProps {
  open: boolean
  onClose: () => void
  opcodeUrl: string | null | undefined
  sessionID: string
  directory?: string
  repoId?: number
  global?: boolean
  onExecuteCommand?: (command: CommandWithScope, run: boolean, args: string) => void
  onScrollToMessage?: (messageID: string) => void
}

interface RunSessionMeta {
  title: string
  repoId: number
  directory: string
  repoName: string
}

type RunStatus = 'running' | 'completed' | 'error'

interface SegmentedRun {
  name: string
  args: string
  startedAt: number
  trigger: string | null
  triggerMessageID: string | null
  result: string
  steps: string[]
  status: RunStatus
  lastUpdated: number
  stepCount: number
}

function partText(part: Part): string {
  return part.type === 'text' ? (part.text ?? '') : ''
}

function assistantText(message: MessageWithParts): string {
  return message.parts.filter((p) => p.type === 'text').map(partText).join('\n')
}

function assistantSteps(message: MessageWithParts): string[] {
  return message.parts
    .filter((p) => p.type === 'tool')
    .map((p) => p.tool)
}

function segmentRun(
  messages: MessageWithParts[],
  run: { startedAt: number; name?: string },
  oneshot = false,
): Pick<SegmentedRun, 'trigger' | 'triggerMessageID' | 'result' | 'steps' | 'status' | 'lastUpdated' | 'stepCount'> {
  let sawTrigger = false
  const assistantMessages: MessageWithParts[] = []
  let trigger: string | null = null
  let triggerMessageID: string | null = null
  let lastUpdated = run.startedAt
  let stepCount = 0

  for (const message of messages) {
    const created = message.info?.time?.created ?? 0
    if (created < run.startedAt) continue

    if (message.info.role === 'user') {
      const isSynthetic = message.parts.length > 0 && message.parts.every((p) => 'synthetic' in p && p.synthetic)
      if (isSynthetic) continue

      if (!sawTrigger) {
        sawTrigger = true
        trigger = assistantText(message) || null
        triggerMessageID = message.info.id
        if (created > lastUpdated) lastUpdated = created
      } else {
        break
      }
      continue
    }

    if (sawTrigger) {
      assistantMessages.push(message)
      stepCount += message.parts.filter((p) => p.type === 'step-start').length
      if (created > lastUpdated) lastUpdated = created
    }
  }

  let status: RunStatus = 'running'
  if (assistantMessages.length > 0) {
    const last = assistantMessages[assistantMessages.length - 1]
    if ('error' in last.info && last.info.error) {
      status = 'error'
    } else if ('time' in last.info && 'completed' in last.info.time && last.info.time.completed) {
      status = 'completed'
    }
  }

  // Declarative commands (e.g. /help) return immediately with no assistant
  // payload, so we must not hold them in a pending "running" state.
  if (oneshot && status === 'running') status = 'completed'
  if (oneshot) lastUpdated = run.startedAt

  const result = assistantMessages.map(assistantText).filter(Boolean).join('\n')
  if (status === 'running' && assistantMessages.length > 0) {
    const last = assistantMessages[assistantMessages.length - 1]
    if ('time' in last.info && 'completed' in last.info.time && last.info.time.completed) status = 'completed'
  }

  const steps = assistantMessages.map(assistantSteps).flat()
  return { trigger, triggerMessageID, result, steps, status, lastUpdated, stepCount }
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

const SCOPE_DISPLAY: Record<CommandScope, { label: string; className: string }> = {
  builtin: { label: 'built-in', className: 'bg-blue-500/15 text-blue-400 border border-blue-500/30' },
  global: { label: 'global', className: 'bg-purple-500/15 text-purple-400 border border-purple-500/30' },
  project: { label: 'project', className: 'bg-amber-500/15 text-amber-400 border border-amber-500/30' },
}

const SCOPE_ICON: Record<CommandScope, typeof Box> = {
  builtin: Box,
  global: Globe,
  project: Folder,
}

function getSortedScopes(commands: CommandWithScope[]): CommandWithScope[] {
  const order: CommandScope[] = ['builtin', 'global', 'project']
  return [...commands].sort((a, b) => {
    const ao = order.indexOf(a.scope ?? 'builtin')
    const bo = order.indexOf(b.scope ?? 'builtin')
    return ao !== bo ? ao - bo : a.name.localeCompare(b.name)
  })
}

interface CommandExplorerProps {
  commands: CommandWithScope[]
  loading: boolean
  error: string | null
  onExecute?: (command: CommandWithScope, run: boolean, args: string) => void
  onCreate?: () => void
  onEdit?: (command: CommandWithScope) => void
  onDelete?: (command: CommandWithScope) => void
  focusCommand?: CommandWithScope | null
}

interface PendingArgs {
  command: CommandWithScope
  run: boolean
}

function CommandExplorer({ commands, loading, error, onExecute, onCreate, onEdit, onDelete, focusCommand }: CommandExplorerProps) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<CommandWithScope | null>(null)
  const [pendingArgs, setPendingArgs] = useState<PendingArgs | null>(null)
  const [argsInput, setArgsInput] = useState('')

  useEffect(() => {
    if (focusCommand) {
      setSelected(focusCommand)
      setQuery('')
    }
  }, [focusCommand])

  const requestExecute = (command: CommandWithScope, run: boolean) => {
    if (commandNeedsArgs(command)) {
      setArgsInput('')
      setPendingArgs({ command, run })
      return
    }
    onExecute?.(command, run, '')
  }

  const confirmArgs = () => {
    if (!pendingArgs) return
    onExecute?.(pendingArgs.command, pendingArgs.run, argsInput.trim())
    setPendingArgs(null)
    setArgsInput('')
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    const base = q ? commands.filter(c => c.name.toLowerCase().includes(q) || c.description?.toLowerCase().includes(q)) : commands
    return getSortedScopes(base)
  }, [commands, query])

  const pendingCommand = pendingArgs?.command

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <Dialog open={!!pendingArgs} onOpenChange={(open) => !open && setPendingArgs(null)}>
        <DialogContent hideCloseButton className="max-w-md">
          <DialogHeader>
            <DialogTitle>Run /{pendingCommand?.name}</DialogTitle>
          </DialogHeader>
          {pendingCommand?.template?.includes('$ARGUMENTS') ? (
            <>
              <p className="text-xs text-muted-foreground">Enter the arguments for this command.</p>
              <Input
                value={argsInput}
                onChange={(e) => setArgsInput(e.target.value)}
                placeholder="e.g. Button"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') confirmArgs()
                }}
              />
            </>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">This command accepts positional arguments ($1, $2, ...).</p>
              <Input
                value={argsInput}
                onChange={(e) => setArgsInput(e.target.value)}
                placeholder="e.g. curConfig src"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') confirmArgs()
                }}
              />
            </>
          )}
          <DialogFooter>
            <Button size="sm" variant="ghost" onClick={() => setPendingArgs(null)}>
              Cancel
            </Button>
            <Button size="sm" onClick={confirmArgs}>
              {pendingArgs?.run ? 'Run' : 'Use in chat'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="px-3 pt-2 pb-1 flex-shrink-0">
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search commands..."
              className="w-full h-8 pl-8 pr-3 rounded-md bg-muted/40 border border-border text-xs focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <Button variant="secondary" size="sm" onClick={onCreate} className="h-8 gap-1 text-xs flex-shrink-0">
            <Plus className="w-3.5 h-3.5" />
            New
          </Button>
        </div>
        {error && <p className="text-[11px] text-destructive mt-1">{error}</p>}
      </div>

      <div className="flex-1 overflow-y-auto min-h-0 px-2 pb-2">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full px-6 text-center">
            <Search className="w-8 h-8 mb-2 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No commands found.</p>
          </div>
        ) : (
          <div className="space-y-1">
            {filtered.map((command) => {
              const scope = command.scope ?? 'builtin'
              const badge = SCOPE_DISPLAY[scope]
              const Icon = SCOPE_ICON[scope]
              const isSelected = selected?.name === command.name

              return (
                <div
                  key={command.name}
                  className={`rounded-md border transition-colors ${
                    isSelected ? 'border-primary/50 bg-primary/5' : 'border-transparent hover:bg-muted/40'
                  }`}
                >
                  <button
                    type="button"
                    className="w-full flex items-center gap-2 px-2 py-1.5 text-left"
                    onClick={() => setSelected(isSelected ? null : command)}
                  >
                    <Icon className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                    <span className="font-mono text-xs font-medium flex-1 min-w-0 truncate">/{command.name}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] flex-shrink-0 ${badge.className}`}>
                      {badge.label}
                    </span>
                    {isSelected ? <ChevronDown className="w-3 h-3 text-muted-foreground" /> : <ChevronRight className="w-3 h-3 text-muted-foreground" />}
                  </button>
                  {isSelected && (
                    <div className="px-3 py-2 border-t border-border/50 space-y-1.5">
                      <p className="text-xs text-muted-foreground">{command.description || 'No description.'}</p>
                      {command.template ? (
                        <div className="rounded-md bg-muted/30 border border-border p-2">
                          <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">template</p>
                          <pre className="text-[11px] text-foreground whitespace-pre-wrap break-words font-mono max-h-40 overflow-y-auto">{command.template}</pre>
                        </div>
                      ) : (
                        <p className="text-[10px] text-muted-foreground">
                          Use /{command.name} in chat to {command.oneshot ? 'open this panel' : 'run this command'}.
                        </p>
                      )}
                      <div className="flex items-center gap-3 pt-1">
                        <button
                          type="button"
                          onClick={() => requestExecute(command, true)}
                          className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
                        >
                          <Terminal className="w-3 h-3" /> Run
                        </button>
                        <button
                          type="button"
                          onClick={() => requestExecute(command, false)}
                          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                        >
                          Use in chat
                        </button>
                        {command.scope !== 'builtin' && (
                          <>
                            <button
                              type="button"
                              onClick={() => onEdit?.(command)}
                              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                            >
                              <Edit className="w-3 h-3" /> Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => onDelete?.(command)}
                              className="inline-flex items-center gap-1 text-[11px] text-red-400 hover:text-red-300 hover:underline"
                            >
                              <Trash2 className="w-3 h-3" /> Delete
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

export function CommandsPanel({ open, onClose, opcodeUrl, sessionID, directory, repoId, global = sessionID === '', onExecuteCommand, onScrollToMessage }: CommandsPanelProps) {
  const navigate = useNavigate()
  const { data: messages } = useMessages(opcodeUrl, sessionID, directory)
  const runsBySession = useCommandRuns((state) => state.runsBySession)
  const { data: sessions } = useSessions(opcodeUrl, directory)
  const { commands, loading, error, refresh } = useCommands(opcodeUrl ?? null, directory)
  const [tab, setTab] = useState<'runs' | 'explorer'>('runs')
  const [expanded, setExpanded] = useState<Record<string, { steps: boolean; response: boolean }>>({})
  const [createOpen, setCreateOpen] = useState(false)
  const [historyQuery, setHistoryQuery] = useState('')
  const [explorerFocus, setExplorerFocus] = useState<CommandWithScope | null>(null)
  const [explorerType, setExplorerType] = useState<'command' | 'skill' | 'tool' | 'agent' | 'mcp'>('command')
  const [editingTarget, setEditingTarget] = useState<RegistryEditTarget | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ type: string; name: string; scope: string; kind: 'registry' | 'mcp' | 'command' } | null>(null)
  const [deleting, setDeleting] = useState(false)

  const queryClient = useQueryClient()

  const { data: registryItems = [] } = useQuery({
    queryKey: ['registry-items', directory],
    queryFn: () => registryApi.list(directory),
    enabled: !!opcodeUrl,
  })

  const { data: mcpServers = [] } = useQuery({
    queryKey: ['registry-mcp-servers'],
    queryFn: async () => {
      const config = await settingsApi.getDefaultOpenCodeConfig()
      const mcp = (config?.content?.mcp as Record<string, unknown> | undefined) ?? {}
      return Object.entries(mcp).map(([id, entry]) => ({ id, entry: entry as Record<string, unknown> }))
    },
    enabled: !!opcodeUrl,
  })

  const filteredRegistryItems = useMemo(() => {
    if (explorerType === 'skill' || explorerType === 'tool' || explorerType === 'agent') {
      const typeMap: Record<string, RegistryType> = { skill: 'skill', tool: 'tool', agent: 'agent' }
      return registryItems.filter((item) => item.type === typeMap[explorerType])
    }
    return []
  }, [explorerType, registryItems])

  const refreshRegistry = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['registry-items', directory] })
    queryClient.invalidateQueries({ queryKey: ['registry-mcp-servers'] })
    refresh()
  }, [queryClient, directory, refresh])

  const handleEditCommand = useCallback((command: CommandWithScope) => {
    const isFileBased = command.scope === 'project'
      || registryItems.some((i) => i.type === 'command' && i.scope === 'global' && i.name === command.name)
    setEditingTarget({
      type: 'command',
      scope: command.scope === 'project' ? 'project' : 'global',
      name: command.name,
      description: command.description,
      content: command.template,
      agent: command.agent,
      model: command.model,
      subtask: command.subtask,
      source: isFileBased ? 'file' : 'config',
    })
    setCreateOpen(true)
  }, [registryItems])

  const handleEditRegistryItem = useCallback((item: RegistryListItem) => {
    setEditingTarget({
      type: item.type,
      scope: item.scope,
      name: item.name,
      description: item.description,
      content: item.content,
      mode: item.mode as RegistryEditTarget['mode'],
      source: 'file',
    })
    setCreateOpen(true)
  }, [])

  const handleEditMcp = useCallback((serverId: string, entry: Record<string, unknown>) => {
    setEditingTarget({
      type: 'mcp',
      scope: 'global',
      name: serverId,
      source: 'config',
      mcp: {
        type: entry.type === 'remote' ? 'remote' : 'local',
        enabled: entry.enabled !== false,
        command: Array.isArray(entry.command) ? (entry.command as string[]) : undefined,
        url: typeof entry.url === 'string' ? entry.url : undefined,
        environment: entry.environment as Record<string, string> | undefined,
        timeout: typeof entry.timeout === 'number' ? entry.timeout : undefined,
      },
    })
    setCreateOpen(true)
  }, [])

  const handleDeleteCommand = useCallback(async (command: CommandWithScope) => {
    if (command.scope === 'builtin') return
    if (command.scope === 'project') {
      await registryApi.unregister('command', 'project', command.name, directory)
    } else {
      const fileBased = registryItems.some((i) => i.type === 'command' && i.scope === 'global' && i.name === command.name)
      if (fileBased) {
        await registryApi.unregister('command', 'global', command.name, directory)
      } else {
        const config = await settingsApi.getDefaultOpenCodeConfig()
        if (!config) return
        const commands = { ...((config.content?.command as Record<string, unknown> | undefined) ?? {}) }
        delete commands[command.name]
        await settingsApi.updateOpenCodeConfig(config.name, { content: { ...config.content, command: commands } })
      }
    }
    refreshRegistry()
  }, [registryItems, directory, refreshRegistry])

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      if (deleteTarget.kind === 'registry') {
        await registryApi.unregister(
          deleteTarget.type as RegistryType,
          deleteTarget.scope as 'global' | 'project',
          deleteTarget.name,
          deleteTarget.scope === 'project' ? directory : undefined
        )
      } else if (deleteTarget.kind === 'mcp') {
        const config = await settingsApi.getDefaultOpenCodeConfig()
        if (!config) return
        const mcp = { ...((config.content?.mcp as Record<string, unknown> | undefined) ?? {}) }
        delete mcp[deleteTarget.name]
        await settingsApi.updateOpenCodeConfig(config.name, { content: { ...config.content, mcp } })
      } else if (deleteTarget.kind === 'command') {
        await handleDeleteCommand({ name: deleteTarget.name, scope: deleteTarget.scope as CommandScope, template: '' } as CommandWithScope)
      }
      refreshRegistry()
      setDeleteTarget(null)
    } catch (err) {
      console.error('Failed to delete:', err)
      showToast.error(`Failed to delete "${deleteTarget.name}".`)
    } finally {
      setDeleting(false)
    }
  }, [deleteTarget, directory, refreshRegistry, handleDeleteCommand])

  const availableSkills = useMemo(
    () => commands.filter((c) => c.source === 'skill').map((c) => c.name),
    [commands]
  )

  const currentSessionMeta = useMemo(() => {
    const map: Record<string, RunSessionMeta> = {}
    for (const s of sessions ?? []) {
      map[s.id] = { title: s.title || 'Untitled Session', repoId: repoId ?? 0, directory: directory ?? '', repoName: '' }
    }
    return map
  }, [sessions, repoId, directory])

  const { data: globalSessionMeta } = useQuery({
    queryKey: ['command-history-sessions', opcodeUrl],
    queryFn: async () => {
      if (!opcodeUrl) return {} as Record<string, RunSessionMeta>
      const repos = await listRepos()
      const repoNameOf = (repo: { repoUrl: string; localPath: string }) => {
        if (repo.repoUrl) return repo.repoUrl.split('/').slice(-1)[0].replace('.git', '')
        return repo.localPath || 'repo'
      }
      const map: Record<string, RunSessionMeta> = {}
      await Promise.all(repos.map(async (repo) => {
        try {
          const client = createOpenCodeClient(opcodeUrl, repo.fullPath)
          const sessionList = await client.listSessions()
          for (const s of sessionList) {
            map[s.id] = { title: s.title || 'Untitled Session', repoId: repo.id, directory: repo.fullPath, repoName: repoNameOf(repo) }
          }
        } catch {
          // Ignore per-repo failures
        }
      }))
      return map
    },
    enabled: !!opcodeUrl && global,
  })

  const sessionMeta = useMemo(
    () => (global ? globalSessionMeta ?? {} : currentSessionMeta),
    [global, globalSessionMeta, currentSessionMeta],
  )

  const runList = useMemo(() => {
    if (global) {
      const all: (CommandRunStart & { sessionMeta?: RunSessionMeta })[] = []
      for (const [sid, list] of Object.entries(runsBySession)) {
        if (!list || list.length === 0) continue
        for (const run of list) {
          all.push({ ...run, sessionMeta: sessionMeta[sid] })
        }
      }
      return all.sort((a, b) => a.startedAt - b.startedAt)
    }
    const descendantIDs = sessions ? collectDescendantIDs(sessions, sessionID) : []
    const ids = new Set([sessionID, ...descendantIDs])
    const list: CommandRunStart[] = []
    for (const sid of ids) {
      for (const run of runsBySession[sid] ?? []) list.push(run)
    }
    return list.sort((a, b) => a.startedAt - b.startedAt)
  }, [global, runsBySession, sessionID, sessions, sessionMeta])

  const filteredRunList = useMemo(() => {
    if (!historyQuery.trim()) return runList
    const q = historyQuery.toLowerCase()
    return runList.filter((run) => {
      const cmdText = `${run.name} ${run.args}`.toLowerCase()
      const sessionTitle = (run as { sessionMeta?: RunSessionMeta }).sessionMeta?.title
        ?? sessionMeta[run.sessionID]?.title
        ?? ''
      return cmdText.includes(q) || sessionTitle.toLowerCase().includes(q)
    })
  }, [runList, historyQuery, sessionMeta])

  const segments = useMemo(() => {
    if (global) return []
    const ordered = [...(runList ?? [])].sort((a, b) => a.startedAt - b.startedAt)
    return ordered
      .map((run) => {
        const meta = commands.find((c) => c.name === run.name)
        const segmented = segmentRun(messages ?? [], run, meta?.oneshot)
        return {
          id: run.id,
          name: run.name,
          args: run.args,
          startedAt: run.startedAt,
          sessionID: run.sessionID,
          messageID: run.messageID ?? segmented.triggerMessageID ?? undefined,
          ...segmented,
        }
      })
      .reverse()
  }, [global, runList, messages, commands])

  useEffect(() => {
    if (global) return
    for (const run of runList) {
      if (run.messageID) continue
      const seg = segments.find((s) => s.id === run.id && s.messageID)
      if (seg?.messageID) {
        useCommandRuns.getState().setRunMessage(run.sessionID, run.id, seg.messageID)
      }
    }
  }, [runList, segments, global])

  const handleGoToMessage = useCallback((runSessionID: string, messageID?: string, runRepoId?: number) => {
    if (!global && runSessionID === sessionID) {
      if (messageID) {
        onScrollToMessage?.(messageID)
      }
      return
    }
    const targetRepoId = runRepoId || repoId
    const base = targetRepoId
      ? `/repos/${targetRepoId}/sessions/${runSessionID}`
      : `/session/${runSessionID}`
    navigate(messageID ? `${base}?msg=${encodeURIComponent(messageID)}` : base)
  }, [global, sessionID, repoId, navigate, onScrollToMessage])

  const runningCount = segments.filter((s) => s.status === 'running').length

  if (!open) return null

  const commandByName = (name: string) => commands.find((c) => c.name === name)

  const renderGlobalRun = (run: CommandRunStart & { sessionMeta?: RunSessionMeta }) => (
    <div
      key={run.id}
      className="rounded-lg border border-border bg-background overflow-hidden cursor-pointer hover:border-ring group"
      onClick={() => handleGoToMessage(run.sessionID, run.messageID, run.sessionMeta?.repoId)}
    >
      <div className="flex items-start justify-between gap-2 px-3 py-2">
        <div className="min-w-0">
          <p className="text-xs font-medium text-foreground font-mono truncate">
            /{run.name}{run.args ? ` ${run.args}` : ''}
          </p>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="text-[10px] text-muted-foreground">{formatTime(run.startedAt)}</span>
            {run.sessionMeta && (
              <span className="text-[10px] text-primary/80 truncate max-w-[160px]" title={run.sessionMeta.title}>
                {run.sessionMeta.title}
              </span>
            )}
            {run.sessionMeta?.repoName && (
              <span className="text-[10px] text-muted-foreground truncate max-w-[120px]">· {run.sessionMeta.repoName}</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <CornerDownLeft className="w-3.5 h-3.5 text-primary/80" />
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              useCommandRuns.getState().removeRun(run.sessionID, run.id)
            }}
            className="h-5 w-5 p-0 text-muted-foreground hover:text-red-400 bg-transparent border-none cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
            title="Delete history entry"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  )

  return (
    <div className="fixed inset-0 z-40" style={{ pointerEvents: open ? 'auto' : 'none' }}>
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="absolute top-0 right-0 bottom-0 w-[460px] max-w-full flex flex-col bg-background border-l border-border shadow-2xl">
        <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2">
            <Terminal className="w-4 h-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">Commands</h2>
            {runningCount > 0 && (
              <span className="inline-flex items-center gap-1 text-xs text-amber-500">
                <Loader2 className="w-3 h-3 animate-spin" />
                {runningCount} running
              </span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant={tab === 'runs' ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setTab('runs')}
              className="text-xs h-7"
            >
              <History className="w-3.5 h-3.5 mr-1" />
              History
            </Button>
            <Button
              variant={tab === 'explorer' ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setTab('explorer')}
              className="text-xs h-7"
            >
              <Search className="w-3.5 h-3.5 mr-1" />
              Explorer
            </Button>
            <Button variant="ghost" size="icon" onClick={onClose} className="text-muted-foreground hover:text-foreground hover:bg-muted">
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {tab === 'explorer' ? (
          <div className="flex flex-col h-full min-h-0">
            <div className="px-3 pt-2 flex-shrink-0">
              <div className="flex items-center gap-1.5">
                {([
                  { value: 'command', label: 'Command', icon: Terminal },
                  { value: 'skill', label: 'Skill', icon: Shield },
                  { value: 'tool', label: 'Plugin', icon: Puzzle },
                  { value: 'agent', label: 'Agent', icon: Bot },
                  { value: 'mcp', label: 'MCP', icon: Server },
                ] as const).map((t) => {
                  const Icon = t.icon
                  return (
                    <button
                      key={t.value}
                      type="button"
                      onClick={() => setExplorerType(t.value)}
                      className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-colors ${
                        explorerType === t.value
                          ? 'bg-primary/15 text-primary'
                          : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground'
                      }`}
                    >
                      <Icon className="w-3 h-3" />
                      {t.label}
                    </button>
                  )
                })}
              </div>
            </div>
            {explorerType === 'command' ? (
              <div className="flex-1 min-h-0 flex flex-col">
                <CommandExplorer
                  commands={commands}
                  loading={loading}
                  error={error}
                  onExecute={onExecuteCommand}
                  onCreate={() => setCreateOpen(true)}
                  onEdit={handleEditCommand}
                  onDelete={(command) => setDeleteTarget({ type: 'command', scope: command.scope ?? 'global', name: command.name, kind: 'command' })}
                  focusCommand={explorerFocus}
                />
              </div>
            ) : explorerType === 'mcp' ? (
              <div className="flex flex-col flex-1 min-h-0">
                <div className="px-3 pt-2 pb-1 flex-shrink-0">
                  <Button variant="secondary" size="sm" onClick={() => { setEditingTarget(null); setCreateOpen(true) }} className="h-8 gap-1 text-xs w-full">
                    <Plus className="w-3.5 h-3.5" />
                    Add MCP server
                  </Button>
                </div>
                <div className="flex-1 overflow-y-auto min-h-0 px-2 pb-2">
                  <div className="space-y-1">
                    {mcpServers.length === 0 ? (
                      <div className="flex flex-col items-center justify-center h-full px-6 text-center">
                        <Server className="w-8 h-8 mb-2 text-muted-foreground/40" />
                        <p className="text-sm text-muted-foreground">No MCP servers configured.</p>
                      </div>
                    ) : (
                      mcpServers.map(({ id, entry }) => {
                        const typeLabel = entry.type === 'remote' ? 'remote' : 'local'
                        const detail = entry.type === 'remote'
                          ? String(entry.url ?? '')
                          : Array.isArray(entry.command) ? (entry.command as string[]).join(' ') : ''
                        const enabled = entry.enabled !== false
                        return (
                          <div key={id} className="rounded-md border border-transparent hover:bg-muted/40">
                            <div className="flex items-center gap-2 px-2 py-1.5 text-left">
                              <Server className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                              <span className="font-mono text-xs font-medium flex-1 min-w-0 truncate">{id}</span>
                              <span className={`px-1.5 py-0.5 rounded text-[10px] flex-shrink-0 ${enabled ? 'bg-green-500/15 text-green-400 border border-green-500/30' : 'bg-muted text-muted-foreground border border-border'}`}>
                                {enabled ? 'enabled' : 'disabled'}
                              </span>
                              <span className="px-1.5 py-0.5 rounded text-[10px] bg-purple-500/15 text-purple-400 border border-purple-500/30 flex-shrink-0">{typeLabel}</span>
                              <div className="flex items-center gap-1 flex-shrink-0">
                                <button
                                  type="button"
                                  onClick={() => handleEditMcp(id, entry)}
                                  className="text-muted-foreground hover:text-foreground"
                                  title="Edit MCP server"
                                >
                                  <Edit className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setDeleteTarget({ type: 'mcp', name: id, scope: 'global', kind: 'mcp' })}
                                  className="text-muted-foreground hover:text-red-400"
                                  title="Delete MCP server"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                            {detail && <p className="px-2 pb-1.5 pl-9 text-[11px] text-muted-foreground font-mono truncate">{detail}</p>}
                          </div>
                        )
                      })
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex flex-col flex-1 min-h-0">
                <div className="px-3 pt-2 pb-1 flex-shrink-0">
                  <Button variant="secondary" size="sm" onClick={() => { setEditingTarget(null); setCreateOpen(true) }} className="h-8 gap-1 text-xs w-full">
                    <Plus className="w-3.5 h-3.5" />
                    New {explorerType}
                  </Button>
                </div>
                <div className="flex-1 overflow-y-auto min-h-0 px-2 pb-2">
                  {filteredRegistryItems.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full px-6 text-center">
                      <Search className="w-8 h-8 mb-2 text-muted-foreground/40" />
                      <p className="text-sm text-muted-foreground">No {explorerType} files registered.</p>
                    </div>
                  ) : (
                    <div className="space-y-1">
                      {filteredRegistryItems.map((item) => {
                        const scope = item.scope
                        const badge = SCOPE_DISPLAY[scope]
                        const Icon = SCOPE_ICON[scope]
                        return (
                          <div key={`${item.type}-${item.scope}-${item.name}`} className="rounded-md border border-transparent hover:bg-muted/40">
                            <div className="flex items-center gap-2 px-2 py-1.5 text-left">
                              <Icon className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                              <span className="font-mono text-xs font-medium flex-1 min-w-0 truncate">{item.name}</span>
                              <span className={`px-1.5 py-0.5 rounded text-[10px] flex-shrink-0 ${badge.className}`}>{badge.label}</span>
                              <div className="flex items-center gap-1 flex-shrink-0">
                                <button
                                  type="button"
                                  onClick={() => handleEditRegistryItem(item)}
                                  className="text-muted-foreground hover:text-foreground"
                                  title="Edit"
                                >
                                  <Edit className="w-3.5 h-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setDeleteTarget({ type: item.type, name: item.name, scope: item.scope, kind: 'registry' })}
                                  className="text-muted-foreground hover:text-red-400"
                                  title="Delete"
                                >
                                  <Trash2 className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </div>
                            {item.description && <p className="px-2 pb-1.5 pl-9 text-[11px] text-muted-foreground line-clamp-2">{item.description}</p>}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto min-h-0">
            {runList.length > 0 && (
              <div className="p-3 pb-0">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                  <Input
                    value={historyQuery}
                    onChange={(e) => setHistoryQuery(e.target.value)}
                    placeholder="Search history..."
                    className="pl-8 h-8 text-xs"
                  />
                </div>
              </div>
            )}
            {filteredRunList.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full px-6 text-center">
                <History className="w-8 h-8 mb-2 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">
                  {runList.length === 0
                    ? global
                      ? 'No commands executed yet.'
                      : 'No commands executed yet in this session.'
                    : 'No history matches your search.'}
                </p>
              </div>
            ) : global ? (
              <div className="p-3 space-y-3">
                {[...filteredRunList].reverse().map(renderGlobalRun)}
              </div>
            ) : (
              <div className="p-3 space-y-3">
                {segments.filter((s) => filteredRunList.some((r) => r.id === s.id)).map((run) => {
                  const meta = commandByName(run.name)
                  const scope = meta?.scope ?? 'builtin'
                  const badge = SCOPE_DISPLAY[scope]
                  const state = expanded[run.id]
                  const stepsOpen = state?.steps ?? (run.status === 'running')
                  const responseOpen = state?.response ?? false
                  const toggle = (key: 'steps' | 'response', open: boolean) =>
                    setExpanded((prev) => ({ ...prev, [run.id]: { ...(prev[run.id] ?? { steps: false, response: false }), [key]: open } }))
                  const sessionLabel = run.sessionID !== sessionID
                    ? (currentSessionMeta[run.sessionID]?.title ?? run.sessionID)
                    : null
                  return (
                    <div key={run.id} className="rounded-lg border border-border bg-background overflow-hidden">
                      <div className="flex items-start justify-between gap-2 px-3 py-2 border-b border-border bg-muted/30">
                        <div className="min-w-0">
                          <button
                            type="button"
                            onClick={() => {
                              const meta = commandByName(run.name)
                              if (meta) {
                                setExplorerFocus(meta)
                                setTab('explorer')
                              }
                            }}
                            title={meta?.description}
                            className="text-xs font-medium text-foreground font-mono truncate hover:text-primary"
                          >
                            /{run.name}{run.args ? ` ${run.args}` : ''}
                          </button>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <span className="text-[10px] text-muted-foreground">{formatTime(run.startedAt)}</span>
                            {sessionLabel && (
                              <span className="text-[10px] text-primary/80 truncate max-w-[140px]" title={sessionLabel}>
                                {sessionLabel}
                              </span>
                            )}
                            <button
                              type="button"
                              onClick={() => handleGoToMessage(run.sessionID, run.messageID, repoId)}
                              className="inline-flex items-center gap-0.5 text-[10px] text-primary/80 hover:text-primary underline underline-offset-2"
                              title="Go to message in chat"
                            >
                              <CornerDownLeft className="w-2.5 h-2.5" />
                              chat
                            </button>
                            {meta && <span className={`px-1 rounded text-[9px] ${badge.className}`}>{badge.label}</span>}
                            {run.stepCount > 0 && (
                              <span className="text-[10px] text-muted-foreground">{run.stepCount} steps</span>
                            )}
                          </div>
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          {run.status === 'running' ? (
                            <div className="flex items-center gap-1 text-[11px] text-amber-500">
                              <Loader2 className="w-3 h-3 animate-spin" />
                              Running
                            </div>
                          ) : run.status === 'error' ? (
                            <div className="flex items-center gap-1 text-[11px] text-destructive">
                              <AlertCircle className="w-3 h-3" />
                              Error
                            </div>
                          ) : (
                            <div className="flex items-center gap-1 text-[11px] text-green-500">
                              <CheckCircle2 className="w-3 h-3" />
                              Done
                            </div>
                          )}
                          <button
                            type="button"
                            onClick={() => useCommandRuns.getState().removeRun(run.sessionID, run.id)}
                            className="h-5 w-5 p-0 text-muted-foreground hover:text-red-400 bg-transparent border-none cursor-pointer"
                            title="Delete history entry"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                      <div className="px-3 py-2 space-y-2">
                        {meta?.description && (
                          <p className="text-[11px] text-muted-foreground">{meta.description}</p>
                        )}

                        {(run.steps.length > 0 || run.status === 'running') && (
                          <div className="border border-border rounded-md overflow-hidden">
                            <button
                              type="button"
                              onClick={() => toggle('steps', !stepsOpen)}
                              className="w-full flex items-center justify-between px-2.5 py-1.5 text-left hover:bg-muted/40"
                            >
                              <span className="text-[11px] font-medium text-foreground">Steps{run.steps.length > 0 ? ` (${run.steps.length})` : ''}</span>
                              <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${stepsOpen ? '' : '-rotate-90'}`} />
                            </button>
                            {stepsOpen && (
                              <div className="px-2.5 pb-2 space-y-1">
                                {run.steps.length > 0 ? (
                                  run.steps.map((step, i) => (
                                    <div key={i} className="flex items-center gap-1.5 text-[11px] font-mono text-muted-foreground truncate">
                                      <Wrench className="w-3 h-3 flex-shrink-0" />
                                      <span className="truncate">{step}</span>
                                    </div>
                                  ))
                                ) : run.status === 'running' ? (
                                  <p className="text-[11px] text-muted-foreground animate-pulse">Executing steps...</p>
                                ) : (
                                  <p className="text-[11px] text-muted-foreground">(no steps)</p>
                                )}
                              </div>
                            )}
                          </div>
                        )}

                        <div className="border border-border rounded-md overflow-hidden">
                          <button
                            type="button"
                            onClick={() => toggle('response', !responseOpen)}
                            className="w-full flex items-center justify-between px-2.5 py-1.5 text-left hover:bg-muted/40"
                          >
                            <span className="text-[11px] font-medium text-foreground">Response</span>
                            <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${responseOpen ? '' : '-rotate-90'}`} />
                          </button>
                          {responseOpen && (
                            <div className="px-2.5 pb-2">
                              {run.result ? (
                                <pre className="text-xs text-foreground whitespace-pre-wrap break-words font-sans">{run.result}</pre>
                              ) : run.status === 'running' ? (
                                <p className="text-xs text-muted-foreground animate-pulse">Waiting for response...</p>
                              ) : (
                                <p className="text-xs text-muted-foreground">(no text response)</p>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
)}
          </div>
        )}
      </div>
      <CreateCommandDialog
        open={createOpen}
        onOpenChange={(next) => {
          setCreateOpen(next)
          if (!next) setEditingTarget(null)
        }}
        onCreated={() => refreshRegistry()}
        availableSkills={availableSkills}
        directory={directory}
        editing={editingTarget}
        defaultType={explorerType}
      />
      <DeleteDialog
        open={!!deleteTarget}
        onOpenChange={(next) => !next && setDeleteTarget(null)}
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
        title={`Delete ${deleteTarget?.type ?? 'item'}`}
        description={`This will permanently remove the ${deleteTarget?.type ?? 'item'} "${deleteTarget?.name ?? ''}".`}
        itemName={deleteTarget?.name}
        isDeleting={deleting}
      />
    </div>
  )
}