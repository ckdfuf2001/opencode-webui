import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
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
  Bot,
  Sparkles,
  Plug,
  Puzzle,
  Pencil,
  RefreshCw,
  Copy,
  Calendar as CalendarIcon,
  CalendarClock,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useMessages, useSessions, useConfig } from '@/hooks/useOpenCode'
import { useCommandRuns, type CommandRunStart } from '@/stores/commandRunsStore'
import { CreateCommandDialog, type DialogType, type EditingEntry } from '@/components/command/CreateCommandDialog'
import { useCommands, type CommandScope, type CommandWithScope } from '@/hooks/useCommands'
import { collectDescendantIDs } from '@/hooks/usePermissionRequests'
import { listRepos } from '@/api/repos'
import { createOpenCodeClient } from '@/api/opencode'
import { settingsApi } from '@/api/settings'
import { registryApi, type RegistryType, type RegistryScope, type RegistryEntry } from '@/api/registry'
import { listSchedules } from '@/api/schedules'
import { ScheduleCalendar } from '@/components/schedule/ScheduleCalendar'
import { ScheduleManager } from '@/components/schedule/ScheduleManager'
import type { CalendarMarker } from '@/lib/calendar-marker'
import { dateKey, cronScheduleKind, monthCalendarRange, scheduleFiresInWindow } from '@/lib/cron'
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
  return new Date(timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function pluginDescription(content: string): string {
  const match = content.match(/description:\s*["']([^"']*)["']/)
  return match?.[1] ?? 'TypeScript plugin'
}

function stripFrontmatter(content: string): string {
  const trimmed = content.replace(/^\uFEFF/, '')
  if (!trimmed.startsWith('---')) return trimmed
  const end = trimmed.indexOf('\n---', 3)
  if (end === -1) return trimmed
  return trimmed.slice(end + 4).replace(/^\n+/, '')
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
  agents: AgentExplorerItem[]
  mcpServers: McpExplorerItem[]
  plugins: RegistryEntry[]
  loading: boolean
  error: string | null
  onExecute?: (command: CommandWithScope, run: boolean, args: string) => void
  onCreate?: (type: ExplorerResourceType) => void
  onEdit?: (type: DialogType, item: { name: string; scope?: string; description?: string; mode?: string; id?: string }) => void
  onClone?: (type: DialogType, item: { name: string; scope?: string; description?: string; mode?: string; id?: string }) => void
  onDelete?: (type: DialogType, item: { name: string; scope?: string; id?: string }) => void
  focusCommand?: CommandWithScope | null
}

interface PendingArgs {
  command: CommandWithScope
  run: boolean
}

type ExplorerResourceType = 'command' | 'agent' | 'skill' | 'mcp' | 'tool'

interface AgentExplorerItem {
  name: string
  description?: string
  mode?: string
  scope?: string
}

interface McpExplorerItem {
  id: string
  type: string
  status: string
  detail: string
}

const EXPLORER_TABS: { value: ExplorerResourceType; label: string; Icon: typeof Box }[] = [
  { value: 'command', label: 'Commands', Icon: Terminal },
  { value: 'agent', label: 'Agents', Icon: Bot },
  { value: 'skill', label: 'Skills', Icon: Sparkles },
  { value: 'tool', label: 'Plugins', Icon: Puzzle },
  { value: 'mcp', label: 'MCP', Icon: Plug },
]

function CommandExplorer({ commands, agents, mcpServers, plugins, loading, error, onExecute, onCreate, onEdit, onClone, onDelete, focusCommand }: CommandExplorerProps) {
  const [tab, setTab] = useState<ExplorerResourceType>('command')
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

  useEffect(() => {
    setQuery('')
    setSelected(null)
  }, [tab])

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
    if (tab === 'agent') {
      const list = agents.filter(a => a.name.toLowerCase().includes(q) || a.description?.toLowerCase().includes(q))
      return list.sort((a, b) => a.name.localeCompare(b.name))
    }
    if (tab === 'mcp') {
      const list = mcpServers.filter(m => m.id.toLowerCase().includes(q) || m.detail.toLowerCase().includes(q))
      return list.sort((a, b) => a.id.localeCompare(b.id))
    }
    if (tab === 'tool') {
      const list = plugins.filter(p => p.name.toLowerCase().includes(q) || pluginDescription(p.content).toLowerCase().includes(q))
      return list.sort((a, b) => a.name.localeCompare(b.name))
    }
    const base = tab === 'skill'
      ? commands.filter((c) => c.source === 'skill')
      : commands.filter((c) => c.source !== 'skill')
    const list = q
      ? base.filter(c => c.name.toLowerCase().includes(q) || c.description?.toLowerCase().includes(q))
      : base
    return getSortedScopes(list)
  }, [tab, query, commands, agents, mcpServers, plugins])

  const pendingCommand = pendingArgs?.command

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const searchPlaceholder = tab === 'agent' ? 'Search agents...' : tab === 'mcp' ? 'Search MCP servers...' : tab === 'skill' ? 'Search skills...' : tab === 'tool' ? 'Search plugins...' : 'Search commands...'
  const emptyText = tab === 'agent' ? 'No agents found.' : tab === 'mcp' ? 'No MCP servers found.' : tab === 'skill' ? 'No skills found.' : tab === 'tool' ? 'No plugins found.' : 'No commands found.'

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

      <div className="px-3 pt-2 flex-shrink-0">
        <div className="flex items-center gap-1 pb-1 overflow-x-auto">
          {EXPLORER_TABS.map(({ value, label, Icon }) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium whitespace-nowrap ${
                tab === value
                  ? 'bg-primary/15 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/40'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              className="w-full h-8 pl-8 pr-3 rounded-md bg-muted/40 border border-border text-xs focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <Button variant="secondary" size="sm" onClick={() => onCreate?.(tab)} className="h-8 gap-1 text-xs flex-shrink-0">
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
            <p className="text-sm text-muted-foreground">{emptyText}</p>
          </div>
        ) : tab === 'agent' || tab === 'mcp' || tab === 'tool' ? (
          <div className="space-y-1">
            {(filtered as (AgentExplorerItem | McpExplorerItem | RegistryEntry)[]).map((item) => {
              const name = 'id' in item ? item.id : item.name
              const isSelected = selected?.name === name
              const description = 'id' in item
                ? (item as McpExplorerItem).detail
                : tab === 'tool'
                  ? pluginDescription((item as RegistryEntry).content)
                  : (item as AgentExplorerItem).description || 'No description.'
              const badge = 'id' in item
                ? (item as McpExplorerItem).status
                : tab === 'tool'
                  ? (item as RegistryEntry).scope
                  : (item as AgentExplorerItem).scope || 'agent'
              const Icon = tab === 'mcp' ? Plug : tab === 'tool' ? Puzzle : Bot
              const badgeClass = tab === 'mcp'
                ? (badge === 'connected' || badge === 'local' ? 'bg-green-500/15 text-green-400 border border-green-500/30' : 'bg-blue-500/15 text-blue-400 border border-blue-500/30')
                : tab === 'tool'
                  ? (badge === 'project' ? SCOPE_DISPLAY.project.className : SCOPE_DISPLAY.global.className)
                  : (badge === 'project' ? SCOPE_DISPLAY.project.className : SCOPE_DISPLAY.global.className)
              return (
                <div
                  key={name}
                  className={`rounded-md border transition-colors ${
                    isSelected ? 'border-primary/50 bg-primary/5' : 'border-transparent hover:bg-muted/40'
                  }`}
                >
                  <button
                    type="button"
                    className="w-full flex items-center gap-2 px-2 py-1.5 text-left"
                    onClick={() => setSelected(isSelected ? null : { name, description, template: '', agent: '', model: '', subtask: false, scope: 'global' })}
                  >
                    <Icon className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                    <span className="font-mono text-xs font-medium flex-1 min-w-0 truncate">{name}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] flex-shrink-0 ${badgeClass}`}>
                      {badge}
                    </span>
                    {isSelected ? <ChevronDown className="w-3 h-3 text-muted-foreground" /> : <ChevronRight className="w-3 h-3 text-muted-foreground" />}
                  </button>
                  {isSelected && (
                    <div className="px-3 py-2 border-t border-border/50 space-y-1.5">
                      <p className="text-xs text-muted-foreground break-words">{description}</p>
                      <div className="flex items-center gap-3 pt-0.5">
                        <button
                          type="button"
                          onClick={() => onEdit?.(tab === 'mcp' ? 'mcp' : tab === 'tool' ? 'tool' : 'agent', { name, scope: (item as { scope?: string }).scope ?? 'global', description: (item as AgentExplorerItem).description, mode: (item as AgentExplorerItem).mode, id: 'id' in item ? (item as McpExplorerItem).id : undefined })}
                          className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
                        >
                          <Pencil className="w-3 h-3" /> Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => onClone?.(tab === 'mcp' ? 'mcp' : tab === 'tool' ? 'tool' : 'agent', { name, scope: (item as { scope?: string }).scope ?? 'global', description: (item as AgentExplorerItem).description, mode: (item as AgentExplorerItem).mode, id: 'id' in item ? (item as McpExplorerItem).id : undefined })}
                          className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                        >
                          <Copy className="w-3 h-3" /> Clone
                        </button>
                        <button
                          type="button"
                          onClick={() => onDelete?.(tab === 'mcp' ? 'mcp' : tab === 'tool' ? 'tool' : 'agent', { name, scope: (item as { scope?: string }).scope ?? 'global', id: 'id' in item ? (item as McpExplorerItem).id : undefined })}
                          className="inline-flex items-center gap-1 text-[11px] text-destructive hover:underline"
                        >
                          <Trash2 className="w-3 h-3" /> Delete
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        ) : (
          <div className="space-y-1">
            {(filtered as CommandWithScope[]).map((command) => {
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
                      <div className="flex items-center gap-2 pt-1">
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
                      </div>
                      {scope !== 'builtin' && (
                        <div className="flex items-center gap-3 pt-0.5 border-t border-border/50">
                          <button
                            type="button"
                            onClick={() => onEdit?.(tab === 'skill' ? 'skill' : 'command', { name: command.name, scope, description: command.description })}
                            className="inline-flex items-center gap-1 text-[11px] text-primary hover:underline"
                          >
                            <Pencil className="w-3 h-3" /> Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => onClone?.(tab === 'skill' ? 'skill' : 'command', { name: command.name, scope, description: command.description })}
                            className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground hover:underline"
                          >
                            <Copy className="w-3 h-3" /> Clone
                          </button>
                          <button
                            type="button"
                            onClick={() => onDelete?.(tab === 'skill' ? 'skill' : 'command', { name: command.name, scope })}
                            className="inline-flex items-center gap-1 text-[11px] text-destructive hover:underline"
                          >
                            <Trash2 className="w-3 h-3" /> Delete
                          </button>
                        </div>
                      )}
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
  const queryClient = useQueryClient()
  const { data: messages } = useMessages(opcodeUrl, sessionID, directory)
  const runsBySession = useCommandRuns((state) => state.runsBySession)
  const { data: sessions } = useSessions(opcodeUrl, directory)
  const { commands, loading, error, refresh } = useCommands(opcodeUrl ?? null, directory)
  const { data: config } = useConfig(opcodeUrl, directory)
  const [tab, setTab] = useState<'runs' | 'explorer'>('runs')
  const [expanded, setExpanded] = useState<Record<string, { steps: boolean; response: boolean }>>({})
  const [createOpen, setCreateOpen] = useState(false)
  const [createType, setCreateType] = useState<ExplorerResourceType>('command')
  const [editing, setEditing] = useState<EditingEntry | null>(null)
  const [cloning, setCloning] = useState<EditingEntry | null>(null)
  const [historyQuery, setHistoryQuery] = useState('')
  const [calendarView, setCalendarView] = useState(false)
  const [calendarViewDate, setCalendarViewDate] = useState(() => new Date())
  const [scheduleView, setScheduleView] = useState(false)
  const [scheduleDialogDate, setScheduleDialogDate] = useState<Date | null>(null)
  const [explorerFocus, setExplorerFocus] = useState<CommandWithScope | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const { data: plugins = [], refetch: refetchPlugins } = useQuery({
    queryKey: ['registry-list', 'tool', directory],
    queryFn: () => registryApi.list('tool', directory),
  })

  const refreshExplorer = useCallback(async () => {
    setRefreshing(true)
    try {
      await registryApi.reload(directory)
    } catch (err) {
      console.warn('Failed to reload OpenCode instances for refresh:', err)
    }
    refresh()
    refetchPlugins()
    queryClient.invalidateQueries({ queryKey: ['opencode', 'config', opcodeUrl, directory] })
    window.dispatchEvent(new CustomEvent('opencode:commands-refreshed'))
    setRefreshing(false)
  }, [refresh, refetchPlugins, queryClient, opcodeUrl, directory])

  const loadEntry = useCallback(async (type: DialogType, item: { name: string; scope?: string; description?: string; mode?: string; id?: string }): Promise<{ entry: EditingEntry; createType: ExplorerResourceType }> => {
    const configData = await settingsApi.getDefaultOpenCodeConfig()
    const cfg = configData?.content as Record<string, unknown> | undefined

    if (type === 'mcp') {
      const m = ((cfg?.mcp as Record<string, unknown> | undefined) ?? {})[item.id ?? item.name] as Record<string, unknown> | undefined
      return {
        createType: 'mcp',
        entry: {
          kind: 'mcp',
          type: 'mcp',
          scope: 'global',
          name: item.id ?? item.name,
          description: '',
          mcpType: m?.type === 'local' ? 'local' : 'remote',
          mcpCommand: Array.isArray(m?.command) ? (m.command as string[]).join(' ') : '',
          mcpUrl: (m?.url as string) ?? '',
          mcpEnvironment: Object.entries((m?.environment as Record<string, string>) ?? {}).map(([key, value]) => ({ key, value })),
          mcpTimeout: m?.timeout != null ? String(m.timeout) : '',
          mcpEnabled: (m?.enabled as boolean) ?? true,
        },
      }
    }

    if (type === 'agent') {
      const list = await registryApi.list('agent', directory)
      const entry = list.find((e) => e.name === item.name)
      if (entry) {
        return {
          createType: 'agent',
          entry: {
            kind: 'registry',
            type: 'agent',
            scope: entry.scope,
            name: item.name,
            description: entry.description ?? '',
            content: stripFrontmatter(entry.content ?? ''),
            mode: (entry.mode as EditingEntry['mode'] | undefined) ?? (item.mode as EditingEntry['mode'] | undefined) ?? 'all',
          },
        }
      }
      const a = ((cfg?.agent as Record<string, unknown> | undefined) ?? {})[item.name] as Record<string, unknown> | undefined
      if (a) {
        return {
          createType: 'agent',
          entry: {
            kind: 'config-agent',
            type: 'agent',
            scope: 'global',
            name: item.name,
            description: (a.description as string) ?? item.description ?? '',
            mode: ((a.mode as string) ?? item.mode ?? 'all') as EditingEntry['mode'],
            prompt: (a.prompt as string) ?? '',
          },
        }
      }
      return {
        createType: 'agent',
        entry: {
          kind: 'registry',
          type: 'agent',
          scope: (item.scope === 'project' ? 'project' : 'global') as RegistryScope,
          name: item.name,
          description: item.description ?? '',
          content: '',
          mode: (item.mode as EditingEntry['mode'] | undefined) ?? 'all',
        },
      }
    }

    if (type === 'skill') {
      const list = await registryApi.list('skill', directory)
      const entry = list.find((e) => e.name === item.name)
      return {
        createType: 'skill',
        entry: {
          kind: 'registry',
          type: 'skill',
          scope: (entry?.scope ?? (item.scope === 'project' ? 'project' : 'global')) as RegistryScope,
          name: item.name,
          description: item.description ?? '',
          content: stripFrontmatter(entry?.content ?? ''),
        },
      }
    }

    if (type === 'tool') {
      const list = await registryApi.list('tool', directory)
      const entry = list.find((e) => e.name === item.name)
      return {
        createType: 'tool',
        entry: {
          kind: 'registry',
          type: 'tool',
          scope: (entry?.scope ?? (item.scope === 'project' ? 'project' : 'global')) as RegistryScope,
          name: item.name,
          description: '',
          content: entry?.content ?? '',
        },
      }
    }

    const list = await registryApi.list('command', directory)
    const entry = list.find((e) => e.name === item.name)
    if (entry) {
      return {
        createType: 'command',
        entry: {
          kind: 'registry',
          type: 'command',
          scope: entry.scope,
          name: item.name,
          description: entry.description ?? '',
          content: entry.content ?? '',
          agent: entry.agent,
          model: entry.model,
          topP: entry.topP,
          subtask: entry.subtask ?? false,
        },
      }
    }
    const c = ((cfg?.command as Record<string, unknown> | undefined) ?? {})[item.name] as Record<string, unknown> | undefined
    if (c) {
      return {
        createType: 'command',
        entry: {
          kind: 'config-command',
          type: 'command',
          scope: 'global',
          name: item.name,
          description: (c.description as string) ?? '',
          template: (c.template as string) ?? '',
          agent: (c.agent as string) ?? '',
          model: (c.model as string) ?? '',
          topP: c.topP as number | undefined,
          subtask: (c.subtask as boolean) ?? false,
        },
      }
    }
    return {
      createType: 'command',
      entry: {
        kind: 'registry',
        type: 'command',
        scope: (item.scope === 'project' ? 'project' : 'global') as RegistryScope,
        name: item.name,
        description: item.description ?? '',
        content: '',
      },
    }
  }, [directory])

  const handleEdit = useCallback(async (type: DialogType, item: { name: string; scope?: string; description?: string; mode?: string; id?: string }) => {
    try {
      const { entry, createType } = await loadEntry(type, item)
      setEditing(entry)
      setCloning(null)
      setCreateType(createType)
      setCreateOpen(true)
    } catch (err) {
      console.error('Failed to load item for editing:', err)
      showToast.error('Failed to load item for editing.')
    }
  }, [loadEntry])

  const handleClone = useCallback(async (type: DialogType, item: { name: string; scope?: string; description?: string; mode?: string; id?: string }) => {
    try {
      const { entry, createType } = await loadEntry(type, item)
      setCloning(entry)
      setEditing(null)
      setCreateType(createType)
      setCreateOpen(true)
    } catch (err) {
      console.error('Failed to load item for cloning:', err)
      showToast.error('Failed to load item for cloning.')
    }
  }, [loadEntry])

  const handleDelete = useCallback(async (type: DialogType, item: { name: string; scope?: string; id?: string }) => {
    try {
      if (type === 'mcp') {
        const configData = await settingsApi.getDefaultOpenCodeConfig()
        if (!configData) {
          showToast.error('No OpenCode configuration to update.')
          return
        }
        const content = { ...configData.content }
        const mcp = { ...((content.mcp as Record<string, unknown>) ?? {}) }
        delete mcp[item.id ?? item.name]
        content.mcp = mcp
        await settingsApi.updateOpenCodeConfig(configData.name, { content })
        showToast.success(`MCP server "${item.id ?? item.name}" deleted.`)
      } else if (type === 'agent') {
        const configData = await settingsApi.getDefaultOpenCodeConfig()
        const cfg = configData?.content as Record<string, unknown> | undefined
        const inConfig = !!((cfg?.agent as Record<string, unknown> | undefined) ?? {})[item.name]
        if (inConfig && configData) {
          const content = { ...configData.content }
          const agents = { ...((content.agent as Record<string, unknown>) ?? {}) }
          delete agents[item.name]
          content.agent = agents
          await settingsApi.updateOpenCodeConfig(configData.name, { content })
        } else {
          const list = await registryApi.list('agent', directory)
          const entry = list.find((e) => e.name === item.name)
          const scope = entry?.scope ?? 'global'
          await registryApi.unregister('agent', scope, item.name, scope === 'project' ? directory : undefined)
        }
        showToast.success(`Agent "${item.name}" deleted.`)
      } else if (type === 'command') {
        const configData = await settingsApi.getDefaultOpenCodeConfig()
        const cfg = configData?.content as Record<string, unknown> | undefined
        const inConfig = !!((cfg?.command as Record<string, unknown> | undefined) ?? {})[item.name]
        if (inConfig && configData) {
          const content = { ...configData.content }
          const commandsMap = { ...((content.command as Record<string, unknown>) ?? {}) }
          delete commandsMap[item.name]
          content.command = commandsMap
          await settingsApi.updateOpenCodeConfig(configData.name, { content })
        } else {
          const scope = item.scope === 'project' ? 'project' : 'global'
          await registryApi.unregister('command', scope, item.name, scope === 'project' ? directory : undefined)
        }
        showToast.success(`Command "${item.name}" deleted.`)
      } else {
        const registryType = type as RegistryType
        const scope = item.scope === 'project' ? 'project' : 'global'
        await registryApi.unregister(registryType, scope, item.name, scope === 'project' ? directory : undefined)
        showToast.success(`${type === 'skill' ? 'Skill' : 'Plugin'} "${item.name}" deleted.`)
      }
      refreshExplorer()
    } catch (err) {
      console.error('Failed to delete item:', err)
      showToast.error('Failed to delete item.')
    }
  }, [directory, refreshExplorer])


  const availableSkills = useMemo(
    () => commands.filter((c) => c.source === 'skill').map((c) => c.name),
    [commands]
  )

  const { data: agentsRegistry = [] } = useQuery({
    queryKey: ['registry-list', 'agent', directory],
    queryFn: () => registryApi.list('agent', directory),
  })

  const agents = useMemo<AgentExplorerItem[]>(() => {
    const map = config?.agent
    const configAgentNames = new Set(Object.keys(map ?? {}))
    const fromConfig: AgentExplorerItem[] = Object.entries(map ?? {}).map(([name, cfg]) => ({
      name,
      description: (cfg as { description?: string }).description,
      mode: (cfg as { mode?: string }).mode,
      scope: 'global',
    }))
    const fromRegistry: AgentExplorerItem[] = agentsRegistry
      .filter((e) => !configAgentNames.has(e.name))
      .map((e) => ({ name: e.name, description: e.description, mode: e.mode, scope: e.scope }))
    return [...fromConfig, ...fromRegistry].sort((a, b) => a.name.localeCompare(b.name))
  }, [config, agentsRegistry])

  const mcpServers = useMemo<McpExplorerItem[]>(() => {
    const map = config?.mcp
    if (!map) return []
    return Object.entries(map).map(([id, cfg]) => {
      const c = cfg as { type?: string; command?: string[]; url?: string; enabled?: boolean }
      const detail = c.type === 'local' ? (c.command ?? []).join(' ') : (c.url ?? '')
      return {
        id,
        type: c.type ?? 'remote',
        status: c.enabled === false ? 'disabled' : (c.type ?? 'remote'),
        detail,
      }
    })
  }, [config])

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

  const { data: allSchedules = [] } = useQuery({
    queryKey: ['schedules', global ? undefined : repoId],
    queryFn: () => listSchedules(global ? undefined : repoId),
    enabled: open && calendarView,
  })

  const { data: repos = [] } = useQuery({
    queryKey: ['repos'],
    queryFn: listRepos,
    enabled: open && calendarView,
  })
  const repoNameById = useMemo(() => {
    const map: Record<number, string> = {}
    for (const repo of repos) {
      const name = repo.repoUrl ? repo.repoUrl.split('/').slice(-1)[0].replace('.git', '') : repo.localPath || 'repo'
      map[repo.id] = name
    }
    return map
  }, [repos])

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

  const calendarMarkers = useMemo<Record<string, CalendarMarker[]>>(() => {
    const map: Record<string, CalendarMarker[]> = {}
    const { start: scanStart, end: scanEnd } = monthCalendarRange(calendarViewDate)

    for (const schedule of allSchedules) {
      const firesOn = scheduleFiresInWindow(schedule.cron, schedule.createdAt, schedule.activeFrom, schedule.activeUntil)
      const scheduleRepoName = repoNameById[schedule.repoId]
      for (let d = new Date(scanStart); d <= scanEnd; d.setDate(d.getDate() + 1)) {
        if (!firesOn(d)) continue
        const key = dateKey(d)
        map[key] ??= []
        map[key].push({
          id: `sched-${schedule.id}`,
          label: schedule.name,
          kind: cronScheduleKind(schedule.cron),
          detail: schedule.cron,
          project: scheduleRepoName,
          repoName: scheduleRepoName,
        })
      }
    }

    for (const run of runList) {
      const key = dateKey(new Date(run.startedAt))
      const meta = (run as { sessionMeta?: RunSessionMeta }).sessionMeta
      const runRepoName = meta?.repoName ?? (directory?.split(/[\\/]/).filter(Boolean).pop() ?? '')
      map[key] ??= []
      map[key].push({
        id: `run-${run.id}`,
        label: `/${run.name}${run.args ? ` ${run.args}` : ''}`,
        kind: 'run',
        detail: new Date(run.startedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
        sessionID: run.sessionID,
        messageID: run.messageID,
        repoId: meta?.repoId ?? repoId,
        repoName: runRepoName,
        sessionTitle: meta?.title,
        project: runRepoName,
      })
    }
    return map
  }, [allSchedules, runList, calendarViewDate, repoId, directory, repoNameById])

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

  const wasScheduleView = useRef(false)
  useEffect(() => {
    if (wasScheduleView.current && !scheduleView) {
      queryClient.invalidateQueries({ queryKey: ['schedules'] })
    }
    wasScheduleView.current = scheduleView
  }, [scheduleView, queryClient])

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
              <span className="text-[10px] font-semibold text-muted-foreground truncate max-w-[120px]">· {run.sessionMeta.repoName}</span>
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
            <Button
              variant="ghost"
              size="icon"
              onClick={() => { refreshExplorer() }}
              className="text-muted-foreground hover:text-foreground hover:bg-muted"
              title="Refresh"
              disabled={refreshing}
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            </Button>
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
          <CommandExplorer commands={commands} agents={agents} mcpServers={mcpServers} plugins={plugins} loading={loading} error={error} onExecute={onExecuteCommand} onCreate={(type) => { setCreateType(type); setCreateOpen(true) }} onEdit={handleEdit} onClone={handleClone} onDelete={handleDelete} focusCommand={explorerFocus} />
        ) : (
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="p-3 pb-0 flex-shrink-0">
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                  <Input
                    value={calendarView || scheduleView ? '' : historyQuery}
                    disabled={calendarView || scheduleView}
                    onChange={(e) => setHistoryQuery(e.target.value)}
                    placeholder="Search history..."
                    className="pl-8 h-8 text-xs"
                  />
                </div>
                <Button
                  variant={calendarView && !scheduleView ? 'secondary' : 'outline'}
                  size="sm"
                  onClick={() => {
                    setCalendarView((v) => !v)
                    setScheduleView(false)
                    setScheduleDialogDate(null)
                  }}
                  className="text-xs h-8 gap-1"
                  title="Toggle calendar view with schedules and command history"
                >
                  <CalendarIcon className="w-3.5 h-3.5" />
                  달력
                </Button>
                <Button
                  variant={scheduleView ? 'secondary' : 'outline'}
                  size="sm"
                  onClick={() => {
                    setScheduleView((v) => !v)
                    setCalendarView(false)
                    setScheduleDialogDate(null)
                  }}
                  className="text-xs h-8 gap-1"
                  title="Manage schedules"
                >
                  <CalendarClock className="w-3.5 h-3.5" />
                  스케줄
                </Button>
              </div>
            </div>
            {scheduleView ? (
              <div className="flex-1 min-h-0 flex flex-col px-3 pb-3">
                <ScheduleManager
                  repoId={repoId ?? 0}
                  opcodeUrl={opcodeUrl ?? ''}
                  directory={directory}
                  initialDate={scheduleDialogDate}
                  active={open}
                  onNavigate={(path) => navigate(path)}
                />
              </div>
            ) : calendarView ? (
              <div className="flex-1 overflow-y-auto min-h-0">
                <div className="p-3 pt-0 space-y-2">
                  <ScheduleCalendar
                    markersByDate={calendarMarkers}
                    viewDate={calendarViewDate}
                    onViewDateChange={setCalendarViewDate}
                    projectName={global ? undefined : (directory?.split(/[\\/]/).filter(Boolean).pop())}
                    defaultFilters={{ run: true }}
                    onAddDate={(date) => {
                      setScheduleDialogDate(date)
                      setCalendarView(false)
                      setScheduleView(true)
                    }}
                    onGoToSession={(marker) => handleGoToMessage(marker.sessionID ?? '', marker.messageID, marker.repoId)}
                  />
                </div>
              </div>
            ) : filteredRunList.length === 0 ? (
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
          if (!next) {
            setEditing(null)
            setCloning(null)
          }
        }}
        onCreated={() => {
          setEditing(null)
          setCloning(null)
          refreshExplorer()
        }}
        availableSkills={availableSkills}
        directory={directory}
        initialType={createType}
        editing={editing}
        cloning={cloning}
      />
    </div>
  )
}