import { useEffect, useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarClock, ChevronDown, Loader2, Pencil, Play, Plus, Trash2, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  listSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  runScheduleNow,
  type Schedule,
  type ScheduleAction,
} from '@/api/schedules'
import { useCommands } from '@/hooks/useCommands'
import { useOpenCodeClient } from '@/hooks/useOpenCode'
import { useCommandRuns } from '@/stores/commandRunsStore'
import { listRepos } from '@/api/repos'
import { createOpenCodeClient } from '@/api/opencode'
import { ScheduleCalendar } from '@/components/schedule/ScheduleCalendar'
import { KIND_LABEL, KIND_BADGE, type CalendarMarker } from '@/lib/calendar-marker'
import { dateKey, cronScheduleKind, monthCalendarRange, scheduleFiresInWindow } from '@/lib/cron'
import { showToast } from '@/lib/toast'

function repoNameOf(repo: { repoUrl?: string | null; localPath: string }): string {
  if (repo.repoUrl) return repo.repoUrl.split('/').slice(-1)[0].replace('.git', '')
  return repo.localPath || 'repo'
}

interface ScheduleManagerProps {
  repoId: number
  opcodeUrl: string
  directory?: string
  initialDate?: Date | null
  active: boolean
  global?: boolean
  onNavigate: (path: string) => void
}

const EMPTY_FORM = {
  name: '',
  action: 'command' as ScheduleAction,
  command: '',
  prompt: '',
  cron: '0 9 * * *',
  enabled: true,
  activeFrom: '',
  activeUntil: '',
  agent: '',
}

const CRON_PRESETS: { label: string; value: string }[] = [
  { label: 'Every 5 min', value: '*/5 * * * *' },
  { label: 'Every 30 min', value: '*/30 * * * *' },
  { label: 'Hourly', value: '0 * * * *' },
  { label: 'Daily 09:00', value: '0 9 * * *' },
  { label: 'Weekly Mon 09:00', value: '0 9 * * 1' },
]

function formatLastRun(lastRunAt?: number): string {
  if (!lastRunAt) return 'Never'
  return new Date(lastRunAt).toLocaleString()
}

function toDatetimeLocal(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fromDatetimeLocal(value: string): number | undefined {
  if (!value) return undefined
  const ts = new Date(value).getTime()
  return Number.isNaN(ts) ? undefined : ts
}

function formatActiveWindow(schedule: Schedule): string {
  if (!schedule.activeFrom && !schedule.activeUntil) return ''
  const from = schedule.activeFrom ? new Date(schedule.activeFrom).toLocaleString() : '∞'
  const until = schedule.activeUntil ? new Date(schedule.activeUntil).toLocaleString() : '∞'
  return `Active: ${from} ~ ${until}`
}

export function ScheduleManager({ repoId, opcodeUrl, directory, initialDate, active, global, onNavigate }: ScheduleManagerProps) {
  useEffect(() => {
    if (active && initialDate) {
      startCreateForDate(initialDate)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active])

  const queryClient = useQueryClient()
  const [editingId, setEditingId] = useState<number | null>(null)
  const [tab, setTab] = useState<'calendar' | 'form'>('calendar')
  const [form, setForm] = useState(EMPTY_FORM)
  const [targetRepoId, setTargetRepoId] = useState<number | null>(repoId && repoId > 0 ? repoId : null)
  const [sortBy, setSortBy] = useState<'active-first' | 'name' | 'last-run'>('active-first')
  const [saving, setSaving] = useState(false)
  const [runningId, setRunningId] = useState<number | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)

  const { commands } = useCommands(active ? opcodeUrl : null, directory)
  const client = useOpenCodeClient(active ? opcodeUrl : null, directory)

  const { data: agents = [] } = useQuery({
    queryKey: ['agents', opcodeUrl, directory],
    queryFn: () => client!.listAgents(),
    enabled: !!client,
  })

  const [calendarViewDate, setCalendarViewDate] = useState(() => new Date())

  const runsBySession = useCommandRuns((s) => s.runsBySession)

  interface SessionMeta { title: string; repoId: number; repoName: string; directory: string }
  const { data: repos = [] } = useQuery({
    queryKey: ['repos'],
    queryFn: listRepos,
    enabled: active,
  })
  const repoNames = useMemo(
    () => repos.map((repo) => repoNameOf(repo)).filter((name, i, arr) => arr.indexOf(name) === i).sort((a, b) => a.localeCompare(b)),
    [repos],
  )
  const repoNameById = useMemo(() => {
    const map: Record<number, string> = {}
    for (const repo of repos) map[repo.id] = repoNameOf(repo)
    return map
  }, [repos])
  const repoNameByDirectory = useMemo(() => {
    const map: Record<string, string> = {}
    for (const repo of repos) {
      map[repo.localPath.replace(/\\/g, '/').replace(/\/+$/, '')] = repoNameOf(repo)
    }
    return map
  }, [repos])
  const currentProject = repoNameById[repoId] ?? (directory?.split(/[\\/]/).filter(Boolean).pop() ?? '')

  useEffect(() => {
    if (!targetRepoId && repos.length > 0) {
      setTargetRepoId(repos[0].id)
    }
  }, [targetRepoId, repos])
  const { data: globalSessionMeta } = useQuery({
    queryKey: ['schedule-dialog-sessions', opcodeUrl],
    queryFn: async () => {
      if (!opcodeUrl) return {} as Record<string, SessionMeta>
      const repos = await listRepos()
      const map: Record<string, SessionMeta> = {}
      await Promise.all(repos.map(async (repo) => {
        try {
          const client = createOpenCodeClient(opcodeUrl, repo.fullPath)
          const sessionList = await client.listSessions()
          for (const s of sessionList) {
            map[s.id] = { title: s.title || 'Untitled Session', repoId: repo.id, repoName: repoNameOf(repo), directory: repo.fullPath }
          }
        } catch {
          // Ignore per-repo failures
        }
      }))
      return map
    },
    enabled: active && !!opcodeUrl,
  })

  const { data: schedules = [], isLoading } = useQuery({
    queryKey: ['schedules', global ? undefined : repoId],
    queryFn: () => listSchedules(global ? undefined : repoId),
    enabled: active,
  })
  const [listProjects, setListProjects] = useState<string[]>(() =>
    currentProject ? [currentProject] : repoNames.length > 0 ? [...repoNames] : [],
  )
  const filteredSchedules = useMemo(() => {
    if (listProjects.length === 0) return []
    return schedules.filter((s) => {
      const name = repoNameById[s.repoId] ?? ''
      return name ? listProjects.includes(name) : false
    })
  }, [schedules, listProjects, repoNameById])
  const sortedSchedules = useMemo(() => {
    const sorted = [...filteredSchedules]
    switch (sortBy) {
      case 'name':
        return sorted.sort((a, b) => a.name.localeCompare(b.name))
      case 'last-run':
        return sorted.sort((a, b) => (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0))
      default:
        return sorted.sort((a, b) => Number(b.enabled) - Number(a.enabled) || (b.lastRunAt ?? 0) - (a.lastRunAt ?? 0))
    }
  }, [filteredSchedules, sortBy])

  const calendarMarkers = useMemo<Record<string, CalendarMarker[]>>(() => {
    const map: Record<string, CalendarMarker[]> = {}
    const { start: scanStart, end: scanEnd } = monthCalendarRange(calendarViewDate)
    const currentRepo = repos.find((r) => r.id === repoId)
    const scheduleProject = currentRepo ? repoNameOf(currentRepo) : undefined

    for (const schedule of schedules) {
      const firesOn = scheduleFiresInWindow(schedule.cron, schedule.createdAt, schedule.activeFrom, schedule.activeUntil)
      const scheduleRepoName = repoNameById[schedule.repoId] ?? scheduleProject
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
          enabled: schedule.enabled,
        })
      }
    }

    const scanStartKey = dateKey(scanStart)
    const scanEndKey = dateKey(scanEnd)
    for (const [sid, runs] of Object.entries(runsBySession)) {
      if (!runs || runs.length === 0) continue
      for (const run of runs) {
        const key = dateKey(new Date(run.startedAt))
        if (key < scanStartKey || key > scanEndKey) continue
        const meta = globalSessionMeta?.[sid]
        const runDirectory = run.directory ?? meta?.directory
        const hasAttribution = runDirectory != null || meta?.repoId != null
        if (!hasAttribution) continue
        const normRunDir = runDirectory?.replace(/\\/g, '/').replace(/\/+$/, '') ?? ''
        const runRepoName = meta?.repoName ?? (normRunDir ? (repoNameByDirectory[normRunDir] ?? normRunDir.split('/').pop() ?? '') : currentProject)
        map[key] ??= []
        map[key].push({
          id: `run-${run.id}`,
          label: `/${run.name}${run.args ? ` ${run.args}` : ''}`,
          kind: 'run',
          detail: new Date(run.startedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
          sessionID: sid,
          messageID: run.messageID,
          repoId: meta?.repoId ?? repoId,
          repoName: runRepoName,
          sessionTitle: meta?.title,
          project: runRepoName,
        })
      }
    }
    return map
  }, [schedules, calendarViewDate, runsBySession, globalSessionMeta, repoId, repos, repoNameById, repoNameByDirectory, currentProject])

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['schedules'] })
  }

  const resetForm = () => {
    setEditingId(null)
    setTab('calendar')
    setForm(EMPTY_FORM)
  }

  const defaultTargetRepoId = () => (repoId && repoId > 0 ? repoId : (repos[0]?.id ?? repoId))

  const initializeForm = () => {
    setEditingId(null)
    setTab('form')
    setForm(EMPTY_FORM)
    setTargetRepoId(defaultTargetRepoId())
  }

  const startCreate = () => {
    initializeForm()
  }

  const startCreateForDate = (date: Date) => {
    const pad = (n: number) => String(n).padStart(2, '0')
    initializeForm()
    setForm({
      name: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
      action: 'command',
      command: '',
      prompt: '',
      cron: `0 9 ${date.getDate()} ${date.getMonth() + 1} *`,
      enabled: true,
      activeFrom: '',
      activeUntil: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T23:59`,
      agent: '',
    })
  }

  const startEdit = (schedule: Schedule) => {
    setEditingId(schedule.id)
    setTab('form')
    setTargetRepoId(schedule.repoId ?? repoId)
    setForm({
      name: schedule.name,
      action: schedule.action,
      command: schedule.command ?? '',
      prompt: schedule.prompt ?? '',
      cron: schedule.cron,
      enabled: schedule.enabled,
      activeFrom: toDatetimeLocal(schedule.activeFrom),
      activeUntil: toDatetimeLocal(schedule.activeUntil),
      agent: schedule.agent ?? '',
    })
  }

  const handleSave = async () => {
    if (!form.name.trim()) {
      showToast.error('Name is required.')
      return
    }
    if (form.action === 'command' && !form.command.trim()) {
      showToast.error('Command is required for command schedules.')
      return
    }
    if (form.action === 'chat' && !form.prompt.trim()) {
      showToast.error('Prompt is required for chat schedules.')
      return
    }

    setSaving(true)
    try {
      const activeFrom = fromDatetimeLocal(form.activeFrom)
      const activeUntil = fromDatetimeLocal(form.activeUntil)
      if (activeFrom !== undefined && activeUntil !== undefined && activeFrom >= activeUntil) {
        showToast.error('Active start must be before active end.')
        setSaving(false)
        return
      }
      const payload = {
        name: form.name.trim(),
        action: form.action,
        command: form.action === 'command' ? form.command.trim() : undefined,
        prompt: form.action === 'chat' ? form.prompt.trim() : undefined,
        cron: form.cron.trim(),
        enabled: form.enabled,
        activeFrom,
        activeUntil,
        agent: form.agent.trim() || undefined,
      }
      if (editingId) {
        await updateSchedule(editingId, payload)
        showToast.success('Schedule updated.')
      } else {
        await createSchedule({ repoId: targetRepoId ?? repoId, ...payload })
        showToast.success('Schedule created.')
      }
      resetForm()
      invalidate()
    } catch (error) {
      console.error('Failed to save schedule:', error)
      showToast.error(error instanceof Error ? error.message : 'Failed to save schedule.')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: number) => {
    setDeletingId(id)
    try {
      await deleteSchedule(id)
      showToast.success('Schedule deleted.')
      invalidate()
    } catch (error) {
      console.error('Failed to delete schedule:', error)
      showToast.error('Failed to delete schedule.')
    } finally {
      setDeletingId(null)
    }
  }

  const handleToggleEnabled = async (schedule: Schedule, enabled: boolean) => {
    try {
      await updateSchedule(schedule.id, { enabled })
      invalidate()
    } catch (error) {
      console.error('Failed to toggle schedule:', error)
      showToast.error('Failed to update schedule.')
    }
  }

  const handleRunNow = async (schedule: Schedule) => {
    setRunningId(schedule.id)
    try {
      const result = await runScheduleNow(schedule.id)
      if (result.success) {
        showToast.success('Schedule executed. Session created.')
      } else {
        showToast.error('Schedule execution failed.')
      }
      invalidate()
    } catch (error) {
      console.error('Failed to run schedule:', error)
      showToast.error(error instanceof Error ? error.message : 'Failed to run schedule.')
    } finally {
      setRunningId(null)
    }
  }

  return (
    <div className="relative flex-1 min-h-0 overflow-y-auto pr-1">
      {tab === 'form' ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <h4 className="text-sm font-semibold shrink-0">{editingId ? 'Edit Schedule' : 'New Schedule'}</h4>
              <Select value={String(targetRepoId ?? repoId)} onValueChange={(value) => setTargetRepoId(Number(value))}>
                <SelectTrigger className="h-6 px-2 text-xs gap-1 flex-1 min-w-0">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {repos.map((repo) => (
                    <SelectItem key={repo.id} value={String(repo.id)}>
                      {repoNameOf(repo)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button size="icon" variant="ghost" onClick={resetForm} disabled={saving} title="Close" className="h-7 w-7 shrink-0">
              <X className="w-4 h-4" />
            </Button>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">
              Name <span className="text-destructive">*</span>
            </label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. Morning report"
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Action</label>
            <Select
              value={form.action}
              onValueChange={(value) => setForm({ ...form, action: value as ScheduleAction })}
            >
              <SelectTrigger className="bg-background border-border">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="command">Run command</SelectItem>
                <SelectItem value="chat">Send chat message</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {form.action === 'command' ? (
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">
                Command <span className="text-destructive">*</span>
              </label>
              <Input
                value={form.command}
                onChange={(e) => setForm({ ...form, command: e.target.value })}
                placeholder="e.g. report"
                list="schedule-command-options"
              />
              <datalist id="schedule-command-options">
                {commands.map((cmd) => (
                  <option key={cmd.name} value={cmd.name} />
                ))}
              </datalist>
            </div>
          ) : (
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">
                Prompt <span className="text-destructive">*</span>
              </label>
              <Textarea
                value={form.prompt}
                onChange={(e) => setForm({ ...form, prompt: e.target.value })}
                placeholder="Message to send to a new session"
                className="min-h-[120px] font-mono text-xs"
              />
            </div>
          )}

          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">
              Cron <span className="text-destructive">*</span>
            </label>
            <Input
              value={form.cron}
              onChange={(e) => setForm({ ...form, cron: e.target.value })}
              placeholder="0 9 * * *"
              className="font-mono"
            />
            <div className="flex flex-wrap gap-1.5 pt-1">
              {CRON_PRESETS.map((preset) => (
                <button
                  key={preset.value}
                  type="button"
                  onClick={() => setForm({ ...form, cron: preset.value })}
                  className={`text-[11px] px-2 py-0.5 rounded border transition-colors ${
                    form.cron === preset.value
                      ? 'border-blue-500 text-blue-400 bg-blue-500/10'
                      : 'border-border text-muted-foreground hover:text-foreground hover:border-foreground'
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">Format: minute hour day-of-month month day-of-week (5 fields).</p>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Agent</label>
            <Select value={form.agent || 'default'} onValueChange={(value) => setForm({ ...form, agent: value === 'default' ? '' : value })}>
              <SelectTrigger>
                <SelectValue placeholder="Select agent" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Default agent</SelectItem>
                {agents.map((agent) => (
                  <SelectItem key={agent.name} value={agent.name}>
                    {agent.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">Which agent will run this schedule.</p>
          </div>

          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Active window</label>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="text-[11px] text-muted-foreground">From</label>
                <Input
                  type="datetime-local"
                  value={form.activeFrom}
                  onChange={(e) => setForm({ ...form, activeFrom: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <label className="text-[11px] text-muted-foreground">Until</label>
                <Input
                  type="datetime-local"
                  value={form.activeUntil}
                  onChange={(e) => setForm({ ...form, activeUntil: e.target.value })}
                />
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">Leave empty for no time limit.</p>
          </div>

          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
            <Switch checked={form.enabled} onCheckedChange={(checked) => setForm({ ...form, enabled: checked })} />
            Enabled
          </label>

          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={resetForm} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave} disabled={saving} className="gap-1">
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {editingId ? 'Update' : 'Create'}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <ScheduleCalendar
            viewDate={calendarViewDate}
            onViewDateChange={setCalendarViewDate}
            markersByDate={calendarMarkers}
            repos={repoNames}
            projectName={currentProject || undefined}
            onAddDate={startCreateForDate}
            onGoToSession={(marker) => {
              const targetRepoId = marker.repoId ?? repoId
              const base = targetRepoId
                ? `/repos/${targetRepoId}/sessions/${marker.sessionID}`
                : `/session/${marker.sessionID}`
              onNavigate(marker.messageID ? `${base}?msg=${encodeURIComponent(marker.messageID)}` : base)
            }}
          />
          <div className="flex items-center justify-between">
            <Button size="sm" onClick={startCreate} className="gap-1">
              <Plus className="w-3.5 h-3.5" />
              Add Schedule
            </Button>
            <div className="flex items-center gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      'flex items-center gap-1 px-1.5 py-1 rounded border transition-colors leading-none text-[11px] max-w-[130px]',
                      listProjects.length > 0
                        ? 'border-primary/50 text-primary bg-primary/10'
                        : 'border-border text-muted-foreground/50 hover:text-muted-foreground',
                    )}
                    title="Filter by project"
                  >
                    <span className="truncate">
                      {listProjects.length === 0
                        ? 'No project'
                        : listProjects.length === 1
                          ? listProjects[0]
                          : `${listProjects.length} selected`}
                    </span>
                    <ChevronDown className="w-2.5 h-2.5 shrink-0" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="max-h-64 overflow-y-auto min-w-[160px]">
                  <DropdownMenuLabel>Projects</DropdownMenuLabel>
                  <DropdownMenuCheckboxItem
                    checked={repoNames.length > 0 && repoNames.every((r) => listProjects.includes(r))}
                    onCheckedChange={() => {
                      const allSelected = repoNames.length > 0 && repoNames.every((r) => listProjects.includes(r))
                      setListProjects(allSelected ? [] : [...repoNames])
                    }}
                  >
                    All projects
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuSeparator />
                  {repoNames.map((name) => (
                    <DropdownMenuCheckboxItem
                      key={name}
                      checked={listProjects.includes(name)}
                      onCheckedChange={(checked) =>
                        setListProjects(checked ? [...listProjects, name] : listProjects.filter((p) => p !== name))
                      }
                    >
                      {name}
                    </DropdownMenuCheckboxItem>
                  ))}
                  {repoNames.length === 0 && <DropdownMenuItem disabled>No repos</DropdownMenuItem>}
                </DropdownMenuContent>
              </DropdownMenu>
              <Select value={sortBy} onValueChange={(value) => setSortBy(value as typeof sortBy)}>
                <SelectTrigger className="h-6 px-2 text-[11px] gap-1 w-auto">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="active-first">Active first</SelectItem>
                  <SelectItem value="last-run">Last run</SelectItem>
                  <SelectItem value="name">Name</SelectItem>
                </SelectContent>
              </Select>
              <Badge variant="outline" className="text-xs">
                <CalendarClock className="w-3 h-3 mr-1" />
                {sortedSchedules.length}
              </Badge>
            </div>
          </div>

          {isLoading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : schedules.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-10">
              No schedules yet. Add one to run a command or chat on a fixed schedule.
            </p>
          ) : filteredSchedules.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-10">No schedules match the selected project.</p>
          ) : (
            <div className="space-y-2 max-h-[50vh] overflow-y-auto pr-1">
              {sortedSchedules.map((schedule) => (
                <div key={schedule.id} className="rounded-lg border border-border bg-card p-3 space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Switch
                        checked={schedule.enabled}
                        onCheckedChange={(checked) => handleToggleEnabled(schedule, checked)}
                      />
                      <span className="text-sm font-medium truncate">{schedule.name}</span>
                      <span className={`px-1 py-[1px] rounded border text-[9px] leading-none truncate shrink-0 ${KIND_BADGE[cronScheduleKind(schedule.cron)] ?? ''}`}>
                        {KIND_LABEL[cronScheduleKind(schedule.cron)]}
                      </span>
                      <Badge variant="outline" className="text-[10px] shrink-0">
                        {schedule.action === 'command' ? 'Command' : 'Chat'}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button type="button" variant="outline" size="icon" className="h-7 w-7" onClick={() => handleRunNow(schedule)} disabled={runningId === schedule.id} title="Run now">
                        {runningId === schedule.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
                      </Button>
                      <Button type="button" variant="outline" size="icon" className="h-7 w-7" onClick={() => startEdit(schedule)} title="Edit">
                        <Pencil className="w-3.5 h-3.5" />
                      </Button>
                      <Button type="button" variant="outline" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" onClick={() => handleDelete(schedule.id)} disabled={deletingId === schedule.id} title="Delete">
                        {deletingId === schedule.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                      </Button>
                    </div>
                  </div>
                  <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                    <div className="flex items-center gap-1.5 min-w-0">
                      {repoNameById[schedule.repoId] && (
                        <span className="font-semibold shrink-0 truncate max-w-[110px]">{repoNameById[schedule.repoId]}</span>
                      )}
                      <span className="font-mono shrink-0">{schedule.cron}</span>
                    </div>
                    <span className="truncate">
                      {schedule.agent ? `${schedule.agent} · ` : ''}
                      {schedule.action === 'command' ? (schedule.command ?? '') : (schedule.prompt ?? '').slice(0, 40)}
                      {' · '}last: {formatLastRun(schedule.lastRunAt)}
                    </span>
                  </div>
                  {formatActiveWindow(schedule) && (
                    <div className="text-[11px] text-muted-foreground">
                      {formatActiveWindow(schedule)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}