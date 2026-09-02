import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueries, useQueryClient } from '@tanstack/react-query'
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
  ListChecks,
  MoreHorizontal,
  Calendar as CalendarIcon,
  Brain,
  Clipboard,
  MessageSquarePlus,
  GitCommit,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { useConfig } from '@/hooks/useOpenCode'
import { useCommandRunView, useDeleteCommandRun, useSetCommandRunMessage } from '@/hooks/useCommandRuns'
import { toCommandRunView } from '@/lib/command-run-view'
import type { CommandRunViewItem, CommandRunStatus } from '@/api/command-runs'
import { CreateCommandDialog, type DialogType, type EditingEntry } from '@/components/command/CreateCommandDialog'
import { useCommands, type CommandScope, type CommandWithScope } from '@/hooks/useCommands'
import { createOpenCodeClient } from '@/api/opencode'
import { settingsApi } from '@/api/settings'
import { registryApi, type RegistryType, type RegistryScope, type RegistryEntry } from '@/api/registry'
import { ScheduleManager } from '@/components/schedule/ScheduleManager'
import { showToast } from '@/lib/toast'
import type { MessageWithParts, Part } from '@/api/types'

// JSON collapsible viewer for Recalls overlay
function JSONViewer({ json }: { json: string }) {
  const [expanded, setExpanded] = useState(true)
  let parsed: any
  try { parsed = JSON.parse(json) } catch { return <pre className="text-[11px] whitespace-pre-wrap break-words font-mono p-2.5 max-h-64 overflow-y-auto text-destructive">{json}</pre> }
  function renderNode(_key: string, value: any, depth = 0): React.ReactNode {
    if (value === null) return <span className="text-muted-foreground">null</span>
    if (typeof value === 'string') return <span className="text-green-400">"{value}"</span>
    if (typeof value === 'number' || typeof value === 'boolean') return <span className="text-yellow-400">{String(value)}</span>
    if (Array.isArray(value)) {
      const [isOpen, setIsOpen] = useState(true)
      if (value.length === 0) return <span className="text-muted-foreground">[]</span>
      return (
        <div className="ml-4">
          <button onClick={(e) => { e.stopPropagation(); setIsOpen(!isOpen) }} className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
            <ChevronRight className={`w-3 h-3 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
            <span>Array[{value.length}]</span>
          </button>
          {isOpen && (
            <div className="ml-2 border-l border-muted/30 pl-2">
              {value.map((v, i) => (
                <div key={i} className="flex gap-1">
                  <span className="text-muted-foreground/50">{i}:</span>
                  {renderNode(String(i), v, depth + 1)}
                </div>
              ))}
            </div>
          )}
        </div>
      )
    }
    if (typeof value === 'object') {
      const entries = Object.entries(value)
      const [isOpen, setIsOpen] = useState(true)
      if (entries.length === 0) return <span className="text-muted-foreground">{{}}</span>
      return (
        <div className="ml-4">
          <button onClick={(e) => { e.stopPropagation(); setIsOpen(!isOpen) }} className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
            <ChevronRight className={`w-3 h-3 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
            <span>Object</span>
          </button>
          {isOpen && (
            <div className="ml-2 border-l border-muted/30 pl-2">
              {entries.map(([k, v]) => (
                <div key={k} className="flex gap-1">
                  <span className="text-cyan-400">"{k}":</span>
                  {renderNode(k, v, depth + 1)}
                </div>
              ))}
            </div>
          )}
        </div>
      )
    }
    return <span className="text-muted-foreground">undefined</span>
  }
  return (
    <div className="font-mono text-[11px]">
      <div className="flex items-center gap-2 mb-2">
        <button onClick={() => setExpanded(!expanded)} className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
          <ChevronRight className={`w-3 h-3 transition-transform ${expanded ? 'rotate-90' : ''}`} />
          <span>{expanded ? '접기' : '펼치기'}</span>
        </button>
      </div>
      {expanded && <div className="ml-2 border-l border-muted/30 pl-2">{renderNode('root', parsed)}</div>}
    </div>
  )
}

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
  onUseInChat?: (text: string) => void
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
  return new Date(timestamp).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
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

function searchRank(name: string, _description: string | undefined, q: string): number {
  const n = name.toLowerCase()
  if (n.startsWith(q)) return 0
  if (n.includes(q)) return 1
  return 2
}

interface CommandExplorerProps {
  commands: CommandWithScope[]
  skills: CommandWithScope[]
  agents: AgentExplorerItem[]
  mcpServers: McpExplorerItem[]
  plugins: RegistryEntry[]
  loading: boolean
  error: string | null
  commandContentLookup?: Map<string, string>
  skillContentLookup?: Map<string, string>
  onExecute?: (command: CommandWithScope, run: boolean, args: string) => void
  onCreate?: (type: ExplorerResourceType) => void
  onEdit?: (type: DialogType, item: { name: string; scope?: string; description?: string; mode?: string; id?: string }) => void
  onClone?: (type: DialogType, item: { name: string; scope?: string; description?: string; mode?: string; id?: string }) => void
  onDelete?: (type: DialogType, item: { name: string; scope?: string; id?: string }) => void
  onBulkDelete?: (type: DialogType, items: { name: string; scope?: string; id?: string }[]) => void
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
  content?: string
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

function CommandExplorer({ commands, skills, agents, mcpServers, plugins, loading, error, commandContentLookup = new Map(), skillContentLookup = new Map(), onExecute, onCreate, onEdit, onClone, onDelete, onBulkDelete, focusCommand }: CommandExplorerProps) {
  const [tab, setTab] = useState<ExplorerResourceType>('command')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<CommandWithScope | null>(null)
  const [pendingArgs, setPendingArgs] = useState<PendingArgs | null>(null)
  const [argsInput, setArgsInput] = useState('')
  const [bulkSelection, setBulkSelection] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (focusCommand) {
      setSelected(focusCommand)
      setQuery('')
    }
  }, [focusCommand])

  useEffect(() => {
    setQuery('')
    setSelected(null)
    setBulkSelection(new Set())
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
      const list = agents.filter(a =>
        a.name.toLowerCase().includes(q) ||
        a.description?.toLowerCase().includes(q) ||
        a.content?.toLowerCase().includes(q))
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
      ? skills
      : commands.filter((c) => c.source !== 'skill')
    const contentLookup = tab === 'skill' ? skillContentLookup : commandContentLookup
    const list = q
      ? base.filter(c => {
          const hay = [
            c.name,
            c.description ?? '',
            'template' in c ? String((c as { template?: unknown }).template ?? '') : '',
            contentLookup.get(c.name) ?? '',
          ].join(' ').toLowerCase()
          return hay.includes(q)
        })
      : base
    if (!q) return getSortedScopes(list)
    return getSortedScopes(list).sort((a, b) =>
      searchRank(a.name, a.description, q) - searchRank(b.name, b.description, q)
    )
  }, [tab, query, commands, skills, agents, mcpServers, plugins, skillContentLookup, commandContentLookup])

  const pendingCommand = pendingArgs?.command

  const itemKey = (item: AgentExplorerItem | McpExplorerItem | RegistryEntry | CommandWithScope): string =>
    'id' in item ? item.id : item.name

  const deletableFiltered = useMemo(() => {
    if (tab === 'command' || tab === 'skill') {
      return (filtered as CommandWithScope[]).filter((c) => (c.scope ?? 'builtin') !== 'builtin')
    }
    return filtered
  }, [tab, filtered])

  const toggleBulkSelection = (key: string) => {
    setBulkSelection((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const allFilteredSelected =
    deletableFiltered.length > 0 && deletableFiltered.every((item) => bulkSelection.has(itemKey(item)))

  const toggleSelectAll = () => {
    if (allFilteredSelected) {
      setBulkSelection(new Set())
    } else {
      setBulkSelection(new Set(deletableFiltered.map((item) => itemKey(item))))
    }
  }

  const confirmBulkDelete = () => {
    if (bulkSelection.size === 0) return
    const items = deletableFiltered
      .filter((item) => bulkSelection.has(itemKey(item)))
      .map((item) => {
        if (tab === 'mcp') {
          return { name: (item as McpExplorerItem).id, id: (item as McpExplorerItem).id, scope: 'global' }
        }
        const it = item as AgentExplorerItem | RegistryEntry | CommandWithScope
        return { name: it.name, scope: (it as { scope?: string }).scope ?? 'global' }
      })
    onBulkDelete?.(tab === 'skill' ? 'skill' : tab === 'mcp' ? 'mcp' : tab === 'tool' ? 'tool' : tab === 'agent' ? 'agent' : 'command', items)
    setBulkSelection(new Set())
  }

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
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant={bulkSelection.size > 0 ? 'default' : 'outline'} size="sm" className="h-8 text-xs flex-shrink-0" title="Bulk actions">
                <MoreHorizontal className="w-3.5 h-3.5" />
                {bulkSelection.size > 0 && `(${bulkSelection.size})`}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {deletableFiltered.length > 0 && (
                <DropdownMenuItem onClick={toggleSelectAll}>
                  <ListChecks className="w-3.5 h-3.5 mr-2" />
                  {allFilteredSelected ? 'Deselect All' : 'Select All'}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem
                onClick={confirmBulkDelete}
                disabled={bulkSelection.size === 0}
                className="text-destructive focus:text-destructive"
              >
                <Trash2 className="w-3.5 h-3.5 mr-2" />
                Delete All ({bulkSelection.size})
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
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
              const isBulkSelected = bulkSelection.has(name)
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
                  <div className="flex items-center gap-1 pl-2">
                    <Checkbox
                      checked={isBulkSelected}
                      onCheckedChange={() => toggleBulkSelection(name)}
                      onClick={(e) => e.stopPropagation()}
                      className="w-4 h-4 flex-shrink-0"
                    />
                    <button
                      type="button"
                      className="flex-1 flex items-center gap-2 px-1 py-1.5 text-left"
                      onClick={() => setSelected(isSelected ? null : { name, description, template: '', agent: '', model: '', subtask: false, scope: 'global' })}
                    >
                    <Icon className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                    <span className="font-mono text-xs font-medium flex-1 min-w-0 truncate">{name}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] flex-shrink-0 ${badgeClass}`}>
                      {badge}
                    </span>
                    {isSelected ? <ChevronDown className="w-3 h-3 text-muted-foreground" /> : <ChevronRight className="w-3 h-3 text-muted-foreground" />}
                  </button>
                  </div>
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
              const isBulkSelected = bulkSelection.has(command.name)
              const isDeletable = scope !== 'builtin'

              return (
                <div
                  key={command.name}
                  className={`rounded-md border transition-colors ${
                    isSelected ? 'border-primary/50 bg-primary/5' : 'border-transparent hover:bg-muted/40'
                  }`}
                >
                  <div className="flex items-center gap-1 pl-2">
                    <Checkbox
                      checked={isBulkSelected}
                      onCheckedChange={() => toggleBulkSelection(command.name)}
                      onClick={(e) => e.stopPropagation()}
                      className="w-4 h-4 flex-shrink-0"
                      disabled={!isDeletable}
                    />
                    <button
                      type="button"
                      className="flex-1 flex items-center gap-2 px-1 py-1.5 text-left"
                      onClick={() => setSelected(isSelected ? null : command)}
                    >
                    <Icon className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                    <span className="font-mono text-xs font-medium flex-1 min-w-0 truncate">/{command.name}</span>
                    <span className={`px-1.5 py-0.5 rounded text-[10px] flex-shrink-0 ${badge.className}`}>
                      {badge.label}
                    </span>
                    {isSelected ? <ChevronDown className="w-3 h-3 text-muted-foreground" /> : <ChevronRight className="w-3 h-3 text-muted-foreground" />}
                  </button>
                  </div>
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

function RecallPanel({ repoId, sessionId, onUseInChat }: { repoId?: number; sessionId: string; onUseInChat?: (text: string) => void }) {
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [selectedRepo, setSelectedRepo] = useState<string>(repoId != null ? String(repoId) : 'all')
  const [k, setK] = useState<string>('8')
  const [kind, setKind] = useState<'all' | 'message' | 'commit'>('all')

  // sync when repoId prop changes (e.g. navigating to different repo)
  useEffect(() => {
    if (repoId != null) setSelectedRepo(String(repoId))
  }, [repoId])

  // live search — debounced, no Search button
  useEffect(() => {
    const t = q.trim()
    if (!t) { setDebouncedQ(''); return }
    const id = setTimeout(() => setDebouncedQ(t), 350)
    return () => clearTimeout(id)
  }, [q])

  const repoIdParam = selectedRepo === 'all' ? undefined : parseInt(selectedRepo, 10)
  const kParam = Math.min(50, Math.max(1, parseInt(k, 10) || 5))

  const { data: repos } = useQuery({
    queryKey: ['repos'],
    queryFn: async () => {
      const { listRepos } = await import('@/api/repos')
      return listRepos()
    },
  })

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['recall', debouncedQ, repoIdParam, kParam, sessionId],
    queryFn: async () => {
      const { recall } = await import('@/api/search')
      return recall(debouncedQ, { k: kParam, repoId: repoIdParam, sessionId: sessionId || undefined })
    },
    enabled: !!debouncedQ,
  })

  const copyText = async (text: string, label = 'Copied to clipboard') => {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text)
      } else {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        const ok = document.execCommand('copy')
        document.body.removeChild(ta)
        if (!ok) throw new Error('execCommand failed')
      }
      showToast.success(label)
    } catch {
      // fallback try execCommand again if clipboard failed
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
        showToast.success(label)
      } catch {
        showToast.error('Failed to copy')
      }
    }
  }

  const useInChat = (text: string) => {
    onUseInChat?.(text)
    showToast.success('Added to chat input')
  }

  const repoName = (id: number | null | undefined) => {
    if (id == null) return `repo #${id}`
    if (id === 0) return 'host (opencode-webui)'
    const r = repos?.find((x) => x.id === id)
    return r ? `${r.localPath} (#${r.id})` : `repo #${id}`
  }

  const navigateRecall = useNavigate()
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [expandedData, setExpandedData] = useState<import('@/api/search').MessageExpandResult | null>(null)
  const [blockOpen, setBlockOpen] = useState(false)

  // 서치 페이지와 동일한 필터 후 hits
  const filteredHits = useMemo(() => {
    if (!data?.hits) return []
    if (kind === 'all') return data.hits
    return data.hits.filter((h) => h.kind === kind)
  }, [data?.hits, kind])

  const filteredJson = useMemo(() => {
    if (!filteredHits.length) return ''
    const arr = filteredHits.map((h) => {
      if (h.kind === 'message' && h.messageId && expandedId === h.messageId && expandedData) {
        return { kind: h.kind, repo: repoName(h.repoId), repoId: h.repoId, sessionId: h.sessionId, messageId: h.messageId, turnIndex: h.turnIndex, role: h.role, ts: h.ts, snippet: h.snippet, expanded: expandedData.rows }
      }
      return { kind: h.kind, repo: repoName(h.repoId), repoId: h.repoId, sessionId: h.sessionId, messageId: h.messageId, turnIndex: h.turnIndex, role: h.role, ts: h.ts, snippet: h.snippet, meta: h.meta }
    })
    return JSON.stringify(arr, null, 2)
  }, [filteredHits, expandedId, expandedData, repos])

  // 필터 옆 클립보드/채팅 버튼은 전체 블록 — 정제: 상세보기와 동일 양식, 전후 확장 시 해당 히트는 전후 전체로
  const filteredBlock = useMemo(() => {
    if (!data?.hits) return ''
    if (filteredHits.length === 0) return ''
    const lines = ['=======', '<memory-recall>', `query: "${debouncedQ}"`]
    for (const h of filteredHits) {
      const repo = repoName(h.repoId)
      if (h.kind === 'message' && h.messageId && expandedId === h.messageId && expandedData) {
        lines.push(`- [${h.kind}] ${repo} session ${h.sessionId?.slice(0,8) ?? ''}`)
        for (const r of expandedData.rows) lines.push(`${r.role} #${r.turnIndex}\n${r.text}`)
      } else {
        lines.push(`- [${h.kind}] ${h.snippet} — ${h.meta} repo ${repo}`)
      }
    }
    lines.push('</memory-recall>')
    return lines.join('\n')
  }, [data?.hits, filteredHits, debouncedQ, repos, expandedId, expandedData])

  const highlightSnippet = (text: string) => {
    const q = debouncedQ.trim()
    if (!q) return text
    const tokens = q.split(/\s+/).map((t) => t.replace(/[^\p{L}\p{N}_\-]/gu, '').trim()).filter((t) => t.length >= 1)
    if (tokens.length === 0) return text
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`(${tokens.map(esc).join('|')})`, 'gi')
    const parts = text.split(pattern)
    // Use a Set for case-insensitive check
    const lowerTokens = new Set(tokens.map((t) => t.toLowerCase()))
    return parts.map((part, i) =>
      part && lowerTokens.has(part.toLowerCase()) ? (
        <span key={i} className="bg-blue-500/20 text-blue-600 dark:text-blue-400 font-medium rounded px-0.5">
          {part}
        </span>
      ) : (
        <span key={i}>{part}</span>
      )
    )
  }

  const handleExpand = async (messageId: string) => {
    if (expandedId === messageId) { setExpandedId(null); setExpandedData(null); return }
    try {
      const { expandMessage } = await import('@/api/search')
      const data = await expandMessage(messageId, 3)
      setExpandedId(messageId)
      setExpandedData(data)
    } catch { /* ignore */ }
  }

  const handleOpenChatHref = (hit: typeof filteredHits[number]) => {
    if (!hit.sessionId) return '#'
    const hash = hit.messageId ? `#message-${hit.messageId}` : ''
    if (hit.repoId != null && hit.repoId !== 0) return `/repos/${hit.repoId}/sessions/${hit.sessionId}${hash}`
    return `/session/${hit.sessionId}${hash}`
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="p-3 pb-0 flex-shrink-0 space-y-2">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') setDebouncedQ(q.trim()) }}
            placeholder="Recall search — messages & commits (trigram, 자동 검색)"
            className="w-full h-8 pl-8 pr-3 rounded-md bg-muted/40 border border-border text-xs focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>

        {/* 필터부터 chat까지 한 줄(스크롤 없이 100% 조정, 필터 min 없음) — Recalls가 Copy/Chat을 포함한 통일 그룹 */}
        <div className="flex items-center gap-2 relative w-full py-0.5">
          <div className="flex-1 min-w-0">
            <Select value={selectedRepo} onValueChange={setSelectedRepo}>
              <SelectTrigger className="w-full h-7 text-xs min-w-0 [&>span]:truncate">
                <SelectValue placeholder="레포 선택" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Repositories</SelectItem>
                <SelectItem value="0">host (opencode-webui)</SelectItem>
                {repos?.map((r) => (
                  <SelectItem key={r.id} value={String(r.id)}>
                    {r.localPath} (#{r.id})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="w-[68px] shrink-0">
            <Input value={k} onChange={(e) => {
              const v = e.target.value.replace(/\D/g, '')
              setK(v)
            }} onBlur={() => {
              const n = parseInt(k, 10)
              if (!k || isNaN(n) || n < 1) setK('5')
              else if (n > 50) setK('50')
            }} placeholder="hits" className="w-full h-7 text-xs text-center px-1" inputMode="numeric" />
          </div>

          {/* 필터와 Recalls 사이 띄우는 영역 */}
          <div className="w-2 shrink-0" aria-hidden />

          {/* Recalls가 Copy/Chat을 포함한 통일 그룹 — 외곽 h-7로 필터와 동일, 안쪽 두 버튼 더 작게 */}
          <div className="inline-flex items-center gap-1 rounded-md border border-input bg-background shrink-0 h-7 px-1">
            <button
              onClick={() => filteredBlock && setBlockOpen((v) => !v)}
              disabled={!filteredBlock}
              className={`inline-flex items-center gap-1 text-xs h-6 px-2 rounded shrink-0 ${blockOpen ? 'bg-primary/10 text-primary' : 'hover:bg-muted'} disabled:opacity-40 disabled:cursor-not-allowed`}
              title={filteredBlock ? 'Recalls overlay' : 'No recalls to show'}
            >
              <ChevronRight className={`w-3 h-3 transition-transform ${blockOpen ? 'rotate-90' : ''}`} />
              Recalls
            </button>
            <div className="inline-flex items-center rounded overflow-hidden border border-input shrink-0">
              <button
                onClick={() => copyText(filteredJson || filteredBlock, 'Recalls copied (JSON)')}
                disabled={!filteredJson}
                className="inline-flex items-center gap-0.5 text-xs h-5 px-1.5 rounded-none border-r border-input shrink-0 hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                title="Copy Recalls JSON"
              >
                <Clipboard className="w-2.5 h-2.5" /> <span className="text-[10px]">Copy</span>
              </button>
              <button
                onClick={() => useInChat(filteredJson || filteredBlock)}
                disabled={!filteredJson}
                className="inline-flex items-center gap-0.5 text-xs h-5 px-1.5 rounded-none shrink-0 hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                title="Use Recalls JSON in chat"
              >
                <MessageSquarePlus className="w-2.5 h-2.5" /> <span className="text-[10px]">Chat</span>
              </button>
            </div>
          </div>

          {blockOpen && filteredHits.length > 0 && (
            <div className="absolute top-full mt-1 left-0 right-0 z-50 rounded-md border bg-background shadow-xl max-h-80 overflow-y-auto">
              <div className="flex items-center justify-between px-2.5 py-1.5 border-b sticky top-0 bg-background">
                <span className="text-[11px] font-medium">Recalls JSON {kind !== 'all' ? `(${kind})` : ''} — {filteredHits.length} items</span>
                <button onClick={() => setBlockOpen(false)} className="text-muted-foreground hover:text-foreground p-0.5">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="p-2 space-y-1">
                {filteredHits.map((h: any, idx: number) => (
                  <details key={idx} className="rounded border border-border bg-muted/20">
                    <summary className="px-2 py-1 text-[11px] font-mono cursor-pointer flex items-center gap-2">
                      <span className={`px-1 py-0.5 rounded text-[10px] ${h.kind === 'message' ? 'bg-blue-500/15 text-blue-400' : 'bg-amber-500/15 text-amber-400'}`}>{h.kind}</span>
                      <span className="truncate flex-1">{h.snippet.slice(0, 60)}</span>
                      <span className="text-muted-foreground text-[10px]">{h.repoId != null ? `#${h.repoId}` : ''}</span>
                    </summary>
                    <pre className="text-[11px] whitespace-pre-wrap break-words font-mono p-2 bg-background border-t max-h-40 overflow-y-auto">
                      {JSON.stringify(h, null, 2)}
                    </pre>
                  </details>
                ))}
              </div>
            </div>
          )}
        </div>

        <Tabs value={kind} onValueChange={(v) => setKind(v as 'all' | 'message' | 'commit')} className="shrink-0">
          <TabsList className="h-7 shrink-0 flex-nowrap">
            <TabsTrigger value="all" className="text-xs h-6 px-2 shrink-0 whitespace-nowrap">All</TabsTrigger>
            <TabsTrigger value="message" className="text-xs h-6 px-1.5 gap-1 shrink-0 whitespace-nowrap"><History className="w-3 h-3" /> Chat</TabsTrigger>
            <TabsTrigger value="commit" className="text-xs h-6 px-1.5 gap-1 shrink-0 whitespace-nowrap"><GitCommit className="w-3 h-3" /> Git</TabsTrigger>
          </TabsList>
        </Tabs>

        {debouncedQ && (
          <p className="text-[11px] text-muted-foreground">
            Query: <span className="font-mono font-medium text-foreground">&quot;{debouncedQ}&quot;</span>
            {selectedRepo !== 'all' ? ` · ${repoName(repoIdParam ?? null)}` : ' · all repos'}
            {` · ${filteredHits.length}/${data?.hits.length ?? 0} hits`}
            {kind !== 'all' ? ` · ${kind}` : ''}
          </p>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
        {!debouncedQ ? (
          <div className="flex flex-col items-center justify-center h-full px-6 text-center">
            <Brain className="w-8 h-8 mb-2 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">Recall (FTS) — 최근 대화·커밋에서 관련 기억을 찾습니다.</p>
            <p className="text-xs text-muted-foreground/70 mt-1">서치 페이지와 동일: 레포/갯수 필터, git/chat 구분, 클립보드·채팅 사용</p>
          </div>
        ) : isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : isError ? (
          <p className="text-sm text-destructive">검색 실패: {(error as Error).message}</p>
        ) : !data || filteredHits.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <Search className="w-8 h-8 mb-2 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">결과 없음</p>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              {filteredHits.map((h, i) => (
                <div key={i} onClick={() => h.kind === 'message' && h.messageId && handleExpand(h.messageId)} className="rounded-md border border-input bg-background p-2.5 space-y-1.5 cursor-pointer hover:border-primary/30">
                  <div className="flex items-center gap-0 flex-nowrap overflow-hidden rounded-md bg-muted/20">
                    <span className={`px-1.5 py-1 text-[10px] ${h.kind === 'message' ? 'bg-blue-500/15 text-blue-400' : 'bg-amber-500/15 text-amber-400'} shrink-0`}>
                      {h.kind === 'message' ? 'chat' : 'git'}
                    </span>
                    {h.ts && (
                      <span className="px-1.5 py-1 text-[10px] bg-muted/30 whitespace-nowrap shrink-0">
                        {new Date(h.ts).toLocaleTimeString('ko-KR', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                      </span>
                    )}
                    {h.repoId != null && (
                      <span className="px-1.5 py-1 text-[10px] bg-muted/40 truncate max-w-[110px] shrink-0" title={repoName(h.repoId)}>
                        {repoName(h.repoId)}
                      </span>
                    )}
                    {h.sessionId && (
                      <span className="px-1.5 py-1 text-[10px] bg-muted/30 truncate max-w-[90px] shrink-0" title={h.sessionId}>
                        session {h.sessionId.slice(0, 8)}
                      </span>
                    )}
                    <span className="flex-1 min-w-0" />
                    <button
                      onClick={(e) => { e.stopPropagation(); const obj = (expandedId === h.messageId && expandedData) ? { repo: repoName(h.repoId), repoId: h.repoId, sessionId: h.sessionId, messageId: h.messageId, turnIndex: h.turnIndex, role: h.role, ts: h.ts, snippet: h.snippet, expanded: expandedData.rows } : { repo: repoName(h.repoId), repoId: h.repoId, sessionId: h.sessionId, messageId: h.messageId, turnIndex: h.turnIndex, role: h.role, ts: h.ts, snippet: h.snippet, meta: h.meta }; copyText(JSON.stringify(obj, null, 2), 'Copied JSON') }}
                      className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-1 h-5 shrink-0 hover:bg-muted"
                      title="Copy JSON"
                    >
                      <Copy className="w-2.5 h-2.5" /> Copy
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); const t = (expandedId === h.messageId && expandedData) ? expandedData.rows.map((r) => r.text).join('\n\n') : h.snippet; useInChat(t) }}
                      className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-1 h-5 shrink-0 hover:bg-muted"
                    >
                      <MessageSquarePlus className="w-2.5 h-2.5" /> Chat
                    </button>
                  </div>
                  {expandedId === h.messageId && expandedData ? (
                    <div className="space-y-1.5">
                      {expandedData.rows.map((row) => {
                        const isCenter = row.messageId === expandedData.center.messageId
                        return (
                          <div key={row.messageId} className={`p-2 rounded text-xs relative ${isCenter ? 'bg-accent border border-input' : 'bg-muted/30'}`}>
                            <div className="flex gap-2 text-[10px] text-muted-foreground mb-1 pr-20">
                              <span>{row.role}</span>
                              <span>#{row.turnIndex}</span>
                            </div>
                            {isCenter && h.sessionId && (
                              <a
                                href={handleOpenChatHref(h)}
                                target="_blank"
                                rel="noopener noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="absolute top-1.5 right-1.5 inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded bg-background/90 backdrop-blur border border-input shadow-sm hover:bg-muted text-primary underline"
                                title="open chat (new tab, Ctrl+click)"
                              >
                                <CornerDownLeft className="w-2.5 h-2.5" /> open chat
                              </a>
                            )}
                            <div className="whitespace-pre-wrap break-words">{row.text ? highlightSnippet(row.text) : '(empty)'}</div>
                          </div>
                        )
                      })}
                    </div>
                  ) : (
                    <div className="p-2 rounded text-xs bg-accent border border-input">
                      <div className="flex gap-2 text-[10px] text-muted-foreground mb-1">
                        <span>{h.role ?? h.kind}</span>
                        <span>#{h.turnIndex ?? ''}</span>
                      </div>
                      <div className="whitespace-pre-wrap break-words">{highlightSnippet(h.snippet)}</div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export function CommandsPanel({ open, onClose, opcodeUrl, sessionID, directory, repoId, global = sessionID === '', onExecuteCommand, onScrollToMessage, onUseInChat }: CommandsPanelProps) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  // ???경???덉뵬??띿쓺 "??湲?筌ㅼ뮇??: 疫꿸퀗而???????곷섧?紐꾨퓠???⑥쥙???? ??낅뮉??
  // from/to 沃섎챷???????뺤쒔揶쎛 ?遺욧퍕 ??뽰젎 疫꿸퀣? 筌ㅼ뮄??364??깆뱽 ?④쑴沅???嚥?  // ??륁뵠筌왖????살삋 ??곷선??猷?????쎈뻬??筌?獄쏅쉼?앮에?獄쎛??산돌筌왖 ??낅뮉??
  const { data: serverRunItems = [] } = useCommandRunView('all', undefined, undefined, undefined, undefined, open)

  // ??彛?? useCommandRunView??refetchInterval(?醫롫섧?????????뺣뼄.
  const deleteRun = useDeleteCommandRun()
  const setRunMessage = useSetCommandRunMessage()
  const { commands, loading, error, refresh } = useCommands(opcodeUrl ?? null, directory)
  const { data: config } = useConfig(opcodeUrl, directory)
  const [tab, setTab] = useState<'runs' | 'explorer' | 'recall'>('runs')
  const [expanded, setExpanded] = useState<Record<string, { steps: boolean; response: boolean }>>({})
  const [createOpen, setCreateOpen] = useState(false)
  const [createType, setCreateType] = useState<ExplorerResourceType>('command')
  const [editing, setEditing] = useState<EditingEntry | null>(null)
  const [cloning, setCloning] = useState<EditingEntry | null>(null)
  const [historyQuery, setHistoryQuery] = useState('')
  const [calendarView, setCalendarView] = useState(false)
  const [selectedRunIds, setSelectedRunIds] = useState<Set<string>>(new Set())
  const [explorerFocus, setExplorerFocus] = useState<CommandWithScope | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const { data: plugins = [] } = useQuery({
    queryKey: ['registry-list', 'tool', directory],
    queryFn: () => registryApi.list('tool', directory),
  })

  const { data: skillsRegistry = [] } = useQuery({
    queryKey: ['registry-list', 'skill', directory],
    queryFn: () => registryApi.list('skill', directory),
    enabled: open,
    refetchOnMount: 'always',
    staleTime: 0,
  })

  const skills = useMemo<CommandWithScope[]>(() => {
    const fromRegistry: CommandWithScope[] = skillsRegistry.map((e) => ({
      name: e.name,
      description: e.description,
      template: '',
      agent: '',
      model: '',
      subtask: false,
      scope: e.scope === 'project' ? 'project' : 'global',
      source: 'skill',
    }))
    const registryNames = new Set(fromRegistry.map((s) => s.name))
    const fromServer = commands
      .filter((c) => c.source === 'skill' && !registryNames.has(c.name))
      .map((c) => ({ ...c, scope: c.scope ?? 'global' }))
    return [...fromRegistry, ...fromServer]
  }, [skillsRegistry, commands])

  const refreshExplorer = useCallback(async () => {
    setRefreshing(true)
    try {
      await registryApi.reload(directory)
    } catch (err) {
      console.warn('Failed to reload OpenCode instances for refresh:', err)
    }
    await refresh()
    queryClient.invalidateQueries({ queryKey: ['registry-list'] })
    queryClient.invalidateQueries({ queryKey: ['opencode', 'config', opcodeUrl, directory] })
    window.dispatchEvent(new CustomEvent('opencode:commands-refreshed'))
    setRefreshing(false)
  }, [refresh, queryClient, opcodeUrl, directory])

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

  const deleteItem = useCallback(async (type: DialogType, item: { name: string; scope?: string; id?: string }) => {
    if (type === 'mcp') {
      const configData = await settingsApi.getDefaultOpenCodeConfig()
      if (!configData) {
        throw new Error('No OpenCode configuration to update.')
      }
      const content = { ...configData.content }
      const mcp = { ...((content.mcp as Record<string, unknown>) ?? {}) }
      delete mcp[item.id ?? item.name]
      content.mcp = mcp
      await settingsApi.updateOpenCodeConfig(configData.name, { content })
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
    } else {
      const registryType = type as RegistryType
      const scope = item.scope === 'project' ? 'project' : 'global'
      await registryApi.unregister(registryType, scope, item.name, scope === 'project' ? directory : undefined)
    }
  }, [directory])

  const handleDelete = useCallback(async (type: DialogType, item: { name: string; scope?: string; id?: string }) => {
    try {
      await deleteItem(type, item)
      const label = type === 'mcp' ? 'MCP server' : type === 'skill' ? 'Skill' : type === 'tool' ? 'Plugin' : type === 'agent' ? 'Agent' : 'Command'
      showToast.success(`${label} "${item.id ?? item.name}" deleted.`)
      refreshExplorer()
    } catch (err) {
      console.error('Failed to delete item:', err)
      showToast.error('Failed to delete item.')
    }
  }, [deleteItem, refreshExplorer])

  const handleBulkDelete = useCallback(async (type: DialogType, items: { name: string; scope?: string; id?: string }[]) => {
    if (items.length === 0) return
    try {
      await Promise.all(items.map((item) => deleteItem(type, item)))
      showToast.success(`${items.length} item(s) deleted.`)
      refreshExplorer()
    } catch (err) {
      console.error('Failed to delete items:', err)
      showToast.error('Failed to delete items.')
    }
  }, [deleteItem, refreshExplorer])


  const availableSkills = useMemo(
    () => skills.map((s) => s.name),
    [skills]
  )

  const { data: agentsRegistry = [] } = useQuery({
    queryKey: ['registry-list', 'agent', directory],
    queryFn: () => registryApi.list('agent', directory),
  })

  // Explorer ??곸뒠 野꺜??깆뒠: ?源낆쨯 ???뵬 癰귣챶揆(name -> content)
  const { data: registryCommands = [] } = useQuery({
    queryKey: ['registry-list', 'command', directory],
    queryFn: () => registryApi.list('command', directory),
  })
  const { data: registrySkills = [] } = useQuery({
    queryKey: ['registry-list', 'skill', directory],
    queryFn: () => registryApi.list('skill', directory),
  })
  const commandContentLookup = useMemo(() => {
    const m = new Map<string, string>()
    for (const e of registryCommands) m.set(e.name, `${e.content ?? ''}\n${e.description ?? ''}`)
    return m
  }, [registryCommands])
  const skillContentLookup = useMemo(() => {
    const m = new Map<string, string>()
    for (const e of registrySkills) m.set(e.name, `${e.content ?? ''}\n${e.description ?? ''}`)
    return m
  }, [registrySkills])

  const agents = useMemo<AgentExplorerItem[]>(() => {
    const map = config?.agent
    const configAgentNames = new Set(Object.keys(map ?? {}))
    const fromConfig: AgentExplorerItem[] = Object.entries(map ?? {}).map(([name, cfg]) => ({
      name,
      description: (cfg as { description?: string }).description,
      mode: (cfg as { mode?: string }).mode,
      scope: 'global',
      content: (cfg as { prompt?: string }).prompt,
    }))
    const fromRegistry: AgentExplorerItem[] = agentsRegistry
      .filter((e) => !configAgentNames.has(e.name))
      .map((e) => ({ name: e.name, description: e.description, mode: e.mode, scope: e.scope, content: e.content }))
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

  // ??륁뵠筌왖 ?뚢뫂???쎈뱜 ?袁り숲: ?紐꾨???= ?????紐꾨? ??딅７ ??= ??????딅７, 域???= ?袁⑷퍥.
  const scopedItems = useMemo(() => {
    const items = serverRunItems as CommandRunViewItem[]
    if (sessionID) return items.filter((i) => i.sessionId === sessionID)
    if (repoId) return items.filter((i) => i.repoId === repoId)
    return items
  }, [serverRunItems, sessionID, repoId])

  // ?紐꾨?????? ??덉뵬??燁삳?諭?Steps/Response/?怨밴묶)???????遺얇늺?癒?퐣??域밸챶?곫묾??袁る퉸
  // ?遺얇늺??癰귣똻????紐꾨??쇱벥 筌롫뗄?놅쭪?????륁춿??뺣뼄.
  const sessionTargets = useMemo(() => {
    const map = new Map<string, { sessionId: string; directory?: string }>()
    for (const item of scopedItems) {
      const key = `${item.directory ?? ''}|${item.sessionId}`
      if (!map.has(key)) map.set(key, { sessionId: item.sessionId, directory: item.directory ?? undefined })
    }
    return [...map.values()]
  }, [scopedItems])

  const messageQueries = useQueries({
    queries: sessionTargets.map(({ sessionId, directory }) => ({
      queryKey: ['opencode', 'messages', opcodeUrl, sessionId, directory],
      queryFn: async () => {
        const client = createOpenCodeClient(opcodeUrl ?? '', directory)
        return client.listMessages(sessionId)
      },
      enabled: open && !!opcodeUrl && !!sessionId,
      staleTime: 30_000,
      // 鈺곕똻???? ??낅뮉 ?紐꾨??紐? 疫꿸퀡以????? 500 ??쎈쇁 ??곸뵠 鈺곌퀣???椰꾨?瑗????
      retry: false,
    })),
  })

  const getMessageQuery = useCallback((sessionId: string, directory?: string) => {
    const idx = sessionTargets.findIndex(
      (t) => t.sessionId === sessionId && (t.directory ?? '') === (directory ?? ''),
    )
    return idx >= 0 ? messageQueries[idx] : undefined
  }, [sessionTargets, messageQueries])

  const sessionMeta = useMemo(() => {
    const map: Record<string, RunSessionMeta> = {}
    for (const item of scopedItems) {
      map[item.sessionId] = {
        title: item.sessionTitle || 'Untitled Session',
        repoId: item.repoId ?? 0,
        directory: item.directory ?? '',
        repoName: item.repoName ?? '',
      }
    }
    return map
  }, [scopedItems])

  const runList = useMemo(() => {
    return (scopedItems as CommandRunViewItem[])
      .map((item) => ({ ...toCommandRunView(item), sessionMeta: sessionMeta[item.sessionId] }))
      .sort((a, b) => a.startedAt - b.startedAt)
  }, [scopedItems, sessionMeta])

  const segments = useMemo(() => {
    const ordered = [...(runList ?? [])].sort((a, b) => a.startedAt - b.startedAt)
    return ordered
      .map((run) => {
        const mq = getMessageQuery(run.sessionID, run.sessionMeta?.directory || run.directory)
        const msgs = Array.isArray(mq?.data) ? (mq.data as MessageWithParts[]) : undefined
        // 鈺곌퀬????쎈솭(??????紐꾨?????'嚥≪뮆諭??袁⑥┷(??揶?'嚥??띯몿?????쎈돗???얜똾釉?獄쎻뫗?
        const messagesLoaded = Array.isArray(msgs) || mq?.status === 'error'
        const meta = commands.find((c) => c.name === run.name)
        const segmented = segmentRun(msgs ?? [], run, meta?.oneshot)
        return {
          id: run.id,
          name: run.name,
          args: run.args,
          startedAt: run.startedAt,
          sessionID: run.sessionID,
          messageID: run.messageID ?? segmented.triggerMessageID ?? undefined,
          messagesLoaded,
          // ?怨밴묶????μ뵬 筌욊쑴??? ???뵬 疫꿸퀡以?run.status). 筌롫뗄?놅쭪? ?브쑴苑띶첎誘?
          // 筌욊쑵六?餓?'started')?????벥 live ?癒?젟(running/error)??곗쨮筌??????뺣뼄.
          status: run.status === 'started'
            ? ((segmented.status as CommandRunStatus) ?? 'running')
            : run.status === 'failed'
              ? 'error'
              : 'completed',
          steps: segmented.steps ?? [],
          result: segmented.result,
        }
      })
      .reverse()
  }, [runList, getMessageQuery, commands])

  const segmentById = useMemo(() => new Map(segments.map((s) => [s.id, s])), [segments])

  // 野꺜??? 筌뤴뫖以?燁삳?諭??筌뤴뫀諭???곸뒠(筌뤿굝議딆쮯?紐꾩쁽夷?紐꾨∽쭗?믩８???梨몄쮯?怨밴묶夷??쎈?쮯?臾먮뼗 癰귣챶揆)?????怨몄몵嚥???뺣뼄.
  const filteredRunList = useMemo(() => {
    if (!historyQuery.trim()) return runList
    const q = historyQuery.trim().toLowerCase()
    return runList.filter((run) => {
      const meta = sessionMeta[run.sessionID]
      const seg = segmentById.get(run.id)
      const statusLabel =
        run.status === 'started' ? 'running' : run.status
      const hay = [
        `/${run.name}`,
        run.args ?? '',
        meta?.title ?? '',
        meta?.repoName ?? '',
        statusLabel,
        seg?.result ?? '',
        ...(seg?.steps ?? []),
      ]
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }, [runList, historyQuery, sessionMeta, segmentById])

  const toggleRunSelected = useCallback((id: string, checked: boolean) => {
    setSelectedRunIds((prev) => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])

  const selectAllRuns = useCallback(() => {
    setSelectedRunIds(new Set(filteredRunList.map((r) => r.id)))
  }, [filteredRunList])

  const clearRunSelection = useCallback(() => {
    setSelectedRunIds(new Set())
  }, [])

  const deleteSelectedRuns = useCallback(async () => {
    const ids = [...selectedRunIds]
    for (const id of ids) {
      try {
        await deleteRun.mutateAsync(id)
      } catch {
        // ignore per-item delete failure
      }
    }
    setSelectedRunIds(new Set())
  }, [selectedRunIds, deleteRun])

  const syncedMessageIds = useRef<Set<string>>(new Set())

  useEffect(() => {
    for (const run of runList) {
      if (run.messageID) continue
      if (syncedMessageIds.current.has(run.id)) continue
      const seg = segments.find((s) => s.id === run.id && s.messageID)
      if (seg?.messageID) {
        syncedMessageIds.current.add(run.id)
        setRunMessage.mutate({ id: run.id, messageId: seg.messageID })
      }
    }
  }, [runList, segments, setRunMessage])

  const handleGoToMessage = useCallback((runSessionID: string, messageID?: string, runRepoId?: number) => {
    if (!global && runSessionID === sessionID) {
      if (messageID) {
        onScrollToMessage?.(messageID)
      }
      return
    }
    // Global view: resolve target repo via sessionMeta or current repoId
    const targetRepoId = runRepoId ?? sessionMeta[runSessionID]?.repoId ?? repoId
    if (!targetRepoId) {
      showToast.warning('Cannot determine target repository for this run.')
      return
    }
    const base = `/repos/${targetRepoId}/sessions/${runSessionID}`
    navigate(messageID ? `${base}?msg=${encodeURIComponent(messageID)}` : base)
  }, [global, sessionID, repoId, sessionMeta, navigate, onScrollToMessage])

  const runningCount = segments.filter((s) => s.status === 'running').length

  if (!open) return null

  const commandByName = (name: string) => commands.find((c) => c.name === name)

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
            <Button
              variant={tab === 'recall' ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => setTab('recall')}
              className="text-xs h-7"
            >
              <Brain className="w-3.5 h-3.5 mr-1" />
              Recall
            </Button>
            <Button variant="ghost" size="icon" onClick={onClose} className="text-muted-foreground hover:text-foreground hover:bg-muted">
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {tab === 'recall' ? (
          <RecallPanel repoId={repoId} sessionId={sessionID} onUseInChat={onUseInChat} opcodeUrl={opcodeUrl} directory={directory} />
        ) : tab === 'explorer' ? (
          <CommandExplorer commands={commands} skills={skills} agents={agents} mcpServers={mcpServers} plugins={plugins} loading={loading} error={error} commandContentLookup={commandContentLookup} skillContentLookup={skillContentLookup} onExecute={onExecuteCommand} onCreate={(type) => { setCreateType(type); setCreateOpen(true) }} onEdit={handleEdit} onClone={handleClone} onDelete={handleDelete} onBulkDelete={handleBulkDelete} focusCommand={explorerFocus} />
        ) : (
          <div className="flex-1 min-h-0 flex flex-col">
            <div className="p-3 pb-0 flex-shrink-0">
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                  <Input
                    value={calendarView ? '' : historyQuery}
                    disabled={calendarView}
                    onChange={(e) => setHistoryQuery(e.target.value)}
                    placeholder="Search history..."
                    className="pl-8 h-8 text-xs"
                  />
                </div>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => {
                    setCalendarView((v) => !v)
                  }}
                  className={`h-8 w-8 shrink-0 transition-colors ${
                    calendarView
                      ? 'border-foreground text-foreground'
                      : 'border-border/60 text-muted-foreground'
                  }`}
                  title="Toggle calendar view with schedules and command history"
                >
                  {calendarView ? (
                    <History className="w-3.5 h-3.5" />
                  ) : (
                    <CalendarIcon className="w-3.5 h-3.5" />
                  )}
                </Button>
                {!calendarView && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" title="History actions">
                      <MoreHorizontal className="w-3.5 h-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => selectAllRuns()}>Select all</DropdownMenuItem>
                    <DropdownMenuItem onSelect={clearRunSelection} disabled={selectedRunIds.size === 0}>
                      Deselect all
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      disabled={selectedRunIds.size === 0}
                      onSelect={() => void deleteSelectedRuns()}
                    >
                      Delete selected ({selectedRunIds.size})
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                )}
              </div>
            </div>
            {calendarView ? (
              <div className="flex-1 min-h-0 flex flex-col px-3 pb-3 pt-1">
                <ScheduleManager
                  repoId={repoId ?? 0}
                  opcodeUrl={opcodeUrl ?? ''}
                  directory={directory}
                  global={global}
                  active={open}
                  onNavigate={(path) => navigate(path)}
                />
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
              ) : (
                <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3">
                {[...filteredRunList].reverse().map((entry) => {
                  const seg = segmentById.get(entry.id)
                  const run = {
                    ...entry,
                    status: entry.status === 'started'
                      ? ((seg?.status as CommandRunStatus) ?? 'running')
                      : entry.status === 'failed'
                        ? 'error'
                        : 'completed',
                    steps: seg?.steps ?? [],
                    stepCount: seg?.steps?.length ?? 0,
                    result: seg?.result,
                    messageID: entry.messageID ?? seg?.messageID,
                    messagesLoaded: Boolean(seg),
                  }
                  const meta = commandByName(run.name)
                  const scope = meta?.scope ?? 'builtin'
                  const badge = SCOPE_DISPLAY[scope]
                  const state = expanded[run.id]
                  const stepsOpen = state?.steps ?? (run.status === 'running')
                  const responseOpen = state?.response ?? false
                  const toggle = (key: 'steps' | 'response', open: boolean) =>
                    setExpanded((prev) => ({ ...prev, [run.id]: { ...(prev[run.id] ?? { steps: false, response: false }), [key]: open } }))
                  const sessionLabel = run.sessionID !== sessionID
                    ? (sessionMeta[run.sessionID]?.title ?? run.sessionID)
                    : null
                  const repoLabel = sessionMeta[run.sessionID]?.repoName ?? null
                  return (
                    <div key={run.id} className="rounded-lg border border-border bg-background overflow-hidden">
                      <div className="px-3 pt-2 pb-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <Checkbox
                              checked={selectedRunIds.has(run.id)}
                              onCheckedChange={(checked) => toggleRunSelected(run.id, checked === true)}
                              onClick={(e) => e.stopPropagation()}
                              className="shrink-0"
                            />
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
                            {meta && (
                              <span className={`px-1 rounded text-[9px] shrink-0 ${badge.className}`}>{badge.label}</span>
                            )}
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
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
                              onClick={() => deleteRun.mutate(run.id)}
                              className="h-5 w-5 p-0 text-muted-foreground hover:text-red-400 bg-transparent border-none cursor-pointer"
                              title="Delete history entry"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                        <div className="flex items-center flex-wrap gap-x-1.5 gap-y-0.5 mt-1 text-[10px] text-muted-foreground min-w-0">
                          <span className="shrink-0">{formatTime(run.startedAt)}</span>
                          {repoLabel && (
                            <span className="font-semibold truncate max-w-[110px] shrink-0" title={repoLabel}>
                              {repoLabel}
                            </span>
                          )}
                          {sessionLabel && (
                            <span className="text-primary/80 truncate max-w-[150px] min-w-0" title={sessionLabel}>
                              {sessionLabel}
                            </span>
                          )}
                          <button
                            type="button"
                            onClick={() => handleGoToMessage(run.sessionID, run.messageID, run.sessionMeta?.repoId ?? repoId)}
                            className="inline-flex items-center gap-0.5 text-primary/80 hover:text-primary underline underline-offset-2 shrink-0"
                            title="Go to message in chat"
                          >
                            <CornerDownLeft className="w-2.5 h-2.5" />
                            chat
                          </button>
                        </div>
                      </div>
                      <div className="border-t border-border/60 px-3 py-2 space-y-2">
                        {meta?.description && (
                          <p className="text-[11px] text-muted-foreground">{meta.description}</p>
                        )}

                        {(run.messagesLoaded || run.steps.length > 0 || run.status === 'running') && (
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
                                {!run.messagesLoaded ? (
                                  <p className="text-[11px] text-muted-foreground animate-pulse flex items-center gap-1.5">
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                    Loading conversation...
                                  </p>
                                ) : run.steps.length > 0 ? (
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

                        {run.messagesLoaded && (
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
                        )}
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



