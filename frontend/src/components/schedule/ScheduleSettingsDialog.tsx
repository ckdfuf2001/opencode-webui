import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarClock, Loader2, Plus, Trash2, Play, Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
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
import { showToast } from '@/lib/toast'

interface ScheduleSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  repoId: number
  opcodeUrl: string
  directory?: string
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

export function ScheduleSettingsDialog({
  open,
  onOpenChange,
  repoId,
  opcodeUrl,
  directory,
}: ScheduleSettingsDialogProps) {
  const queryClient = useQueryClient()
  const [editingId, setEditingId] = useState<number | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [runningId, setRunningId] = useState<number | null>(null)
  const [deletingId, setDeletingId] = useState<number | null>(null)

  const { commands } = useCommands(open ? opcodeUrl : null, directory)
  const client = useOpenCodeClient(open ? opcodeUrl : null, directory)

  const { data: agents = [] } = useQuery({
    queryKey: ['agents', opcodeUrl, directory],
    queryFn: () => client!.listAgents(),
    enabled: !!client,
  })

  const { data: schedules = [], isLoading } = useQuery({
    queryKey: ['schedules', repoId],
    queryFn: () => listSchedules(repoId),
    enabled: open,
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['schedules', repoId] })
  }

  const resetForm = () => {
    setEditingId(null)
    setFormOpen(false)
    setForm(EMPTY_FORM)
  }

  const startCreate = () => {
    setEditingId(null)
    setFormOpen(true)
    setForm(EMPTY_FORM)
  }

  const startEdit = (schedule: Schedule) => {
    setEditingId(schedule.id)
    setFormOpen(true)
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
        await createSchedule({ repoId, ...payload })
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
    <Dialog open={open} onOpenChange={(next) => {
      if (!next) {
        resetForm()
      }
      onOpenChange(next)
    }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader className="flex-row items-center justify-start gap-2 sm:text-left">
          <DialogTitle>Project Schedules</DialogTitle>
        </DialogHeader>

        {formOpen ? (
            <div className="space-y-4">
              <h4 className="text-sm font-semibold">{editingId ? 'Edit Schedule' : 'New Schedule'}</h4>

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

            <DialogFooter>
              <Button size="sm" variant="ghost" onClick={resetForm} disabled={saving}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleSave} disabled={saving} className="gap-1">
                {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {editingId ? 'Update' : 'Create'}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <Button size="sm" onClick={startCreate} className="gap-1">
                <Plus className="w-3.5 h-3.5" />
                Add Schedule
              </Button>
              <Badge variant="outline" className="text-xs">
                <CalendarClock className="w-3 h-3 mr-1" />
                {schedules.length}
              </Badge>
            </div>

            {isLoading ? (
              <div className="flex items-center justify-center py-10">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              </div>
            ) : schedules.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-10">
                No schedules yet. Add one to run a command or chat on a fixed schedule.
              </p>
            ) : (
              <div className="space-y-2 max-h-[50vh] overflow-y-auto pr-1">
                {schedules.map((schedule) => (
                  <div key={schedule.id} className="rounded-lg border border-border bg-card p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <Switch
                          checked={schedule.enabled}
                          onCheckedChange={(checked) => handleToggleEnabled(schedule, checked)}
                        />
                        <span className="text-sm font-medium truncate">{schedule.name}</span>
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
                      <span className="font-mono">{schedule.cron}</span>
                      <span>
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
      </DialogContent>
    </Dialog>
  )
}
