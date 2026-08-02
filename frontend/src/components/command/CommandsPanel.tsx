import { useMemo, useState } from 'react'
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
  FileCode,
  ChevronDown,
  ChevronRight,
  Wrench,
  Plus,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { useMessages } from '@/hooks/useOpenCode'
import { useCommandRuns } from '@/stores/commandRunsStore'
import { CreateCommandDialog } from '@/components/command/CreateCommandDialog'
import { useCommands, type CommandScope, type CommandWithScope } from '@/hooks/useCommands'
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
  onExecuteCommand?: (command: CommandWithScope, run: boolean, args: string) => void
}

type RunStatus = 'running' | 'completed' | 'error'

interface SegmentedRun {
  name: string
  args: string
  startedAt: number
  trigger: string | null
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
): Pick<SegmentedRun, 'trigger' | 'result' | 'steps' | 'status' | 'lastUpdated' | 'stepCount'> {
  let sawTrigger = false
  const assistantMessages: MessageWithParts[] = []
  let trigger: string | null = null
  let lastUpdated = run.startedAt
  let stepCount = 0

  for (const message of messages) {
    const created = message.info?.time?.created ?? 0
    if (created < run.startedAt) continue

    if (message.info.role === 'user') {
      if (!sawTrigger) {
        sawTrigger = true
        trigger = assistantText(message) || null
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
  return { trigger, result, steps, status, lastUpdated, stepCount }
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

const SCOPE_DISPLAY: Record<CommandScope, { label: string; className: string }> = {
  builtin: { label: 'built-in', className: 'bg-blue-500/15 text-blue-400 border border-blue-500/30' },
  global: { label: 'global', className: 'bg-purple-500/15 text-purple-400 border border-purple-500/30' },
  project: { label: 'project', className: 'bg-amber-500/15 text-amber-400 border border-amber-500/30' },
  custom: { label: 'custom', className: 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30' },
}

const SCOPE_ICON: Record<CommandScope, typeof Box> = {
  builtin: Box,
  global: Globe,
  project: Folder,
  custom: FileCode,
}

function getSortedScopes(commands: CommandWithScope[]): CommandWithScope[] {
  const order: CommandScope[] = ['builtin', 'global', 'project', 'custom']
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
}

interface PendingArgs {
  command: CommandWithScope
  run: boolean
}

function CommandExplorer({ commands, loading, error, onExecute, onCreate }: CommandExplorerProps) {
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<CommandWithScope | null>(null)
  const [pendingArgs, setPendingArgs] = useState<PendingArgs | null>(null)
  const [argsInput, setArgsInput] = useState('')

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
                      {command.steps && command.steps.length > 0 && (
                        <div className="rounded-md bg-muted/30 border border-border p-2">
                          <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">steps</p>
                          <div className="space-y-1">
                            {command.steps.map((step, i) => (
                              <div key={i} className="flex items-center gap-1.5 text-[11px] font-mono text-muted-foreground">
                                <Wrench className="w-3 h-3 flex-shrink-0" />
                                <span className="truncate">{step}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
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

export function CommandsPanel({ open, onClose, opcodeUrl, sessionID, directory, onExecuteCommand }: CommandsPanelProps) {
  const { data: messages } = useMessages(opcodeUrl, sessionID, directory)
  const runList = useCommandRuns((state) => state.runsBySession[sessionID])
  const { commands, loading, error, refresh } = useCommands(opcodeUrl ?? null, directory)
  const [tab, setTab] = useState<'runs' | 'explorer'>('runs')
  const [expanded, setExpanded] = useState<Record<string, { steps: boolean; response: boolean }>>({})
  const [createOpen, setCreateOpen] = useState(false)

  const availableSkills = useMemo(
    () => commands.filter((c) => c.source === 'skill').map((c) => c.name),
    [commands]
  )

  const segments = useMemo(() => {
    const ordered = [...(runList ?? [])].sort((a, b) => a.startedAt - b.startedAt)
    return ordered
      .map((run) => {
        const meta = commands.find((c) => c.name === run.name)
        return {
          id: run.id,
          name: run.name,
          args: run.args,
          startedAt: run.startedAt,
          ...segmentRun(messages ?? [], run, meta?.oneshot),
        }
      })
      .reverse()
  }, [runList, messages, commands])

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
          <CommandExplorer commands={commands} loading={loading} error={error} onExecute={onExecuteCommand} onCreate={() => setCreateOpen(true)} />
        ) : (
          <div className="flex-1 overflow-y-auto min-h-0">
            {segments.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full px-6 text-center">
                <History className="w-8 h-8 mb-2 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">No commands executed yet in this session.</p>
              </div>
            ) : (
              <div className="p-3 space-y-3">
                {segments.map((run) => {
                  const meta = commandByName(run.name)
                  const scope = meta?.scope ?? 'builtin'
                  const badge = SCOPE_DISPLAY[scope]
                  const state = expanded[run.id]
                  const stepsOpen = state?.steps ?? (run.status === 'running')
                  const responseOpen = state?.response ?? false
                  const toggle = (key: 'steps' | 'response', open: boolean) =>
                    setExpanded((prev) => ({ ...prev, [run.id]: { ...(prev[run.id] ?? { steps: false, response: false }), [key]: open } }))
                  return (
                    <div key={run.id} className="rounded-lg border border-border bg-background overflow-hidden">
                      <div className="flex items-start justify-between gap-2 px-3 py-2 border-b border-border bg-muted/30">
                        <div className="min-w-0">
                          <button
                            type="button"
                            onClick={() => meta && setTab('explorer')}
                            title={meta?.description}
                            className="text-xs font-medium text-foreground font-mono truncate hover:text-primary"
                          >
                            /{run.name}{run.args ? ` ${run.args}` : ''}
                          </button>
                          <div className="flex items-center gap-1.5 mt-0.5">
                            <span className="text-[10px] text-muted-foreground">{formatTime(run.startedAt)}</span>
                            {meta && <span className={`px-1 rounded text-[9px] ${badge.className}`}>{badge.label}</span>}
                            {run.stepCount > 0 && (
                              <span className="text-[10px] text-muted-foreground">{run.stepCount} steps</span>
                            )}
                          </div>
                        </div>
                        {run.status === 'running' ? (
                          <div className="flex items-center gap-1 text-[11px] text-amber-500 flex-shrink-0">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            Running
                          </div>
                        ) : run.status === 'error' ? (
                          <div className="flex items-center gap-1 text-[11px] text-destructive flex-shrink-0">
                            <AlertCircle className="w-3 h-3" />
                            Error
                          </div>
                        ) : (
                          <div className="flex items-center gap-1 text-[11px] text-green-500 flex-shrink-0">
                            <CheckCircle2 className="w-3 h-3" />
                            Done
                          </div>
                        )}
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
        onOpenChange={setCreateOpen}
        onCreated={() => refresh()}
        availableSkills={availableSkills}
        directory={directory}
      />
    </div>
  )
}