import { useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import { dateKey, monthCalendarRange } from '@/lib/cron'
import { ChevronDown, ChevronLeft, ChevronRight, CornerDownLeft, Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
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
  KIND_BADGE,
  KIND_LABEL,
  defaultCalendarFilters,
  type CalendarFilters,
  type CalendarMarker,
  type CalendarMarkerKind,
} from '@/lib/calendar-marker'

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

interface CalendarDay {
  date: Date
  key: string
  inCurrentMonth: boolean
}

function buildDayGrid(now: Date): CalendarDay[] {
  const { start, end } = monthCalendarRange(now)

  const days: CalendarDay[] = []
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    days.push({
      date: new Date(d),
      key: dateKey(d),
      inCurrentMonth: d.getMonth() === now.getMonth(),
    })
  }
  return days
}

interface DayGroup {
  kind: CalendarMarkerKind
  count: number
  labels: string[]
}

function kindVisible(filters: CalendarFilters, kind: CalendarMarkerKind): boolean {
  return filters[kind]
}

function markerVisible(m: CalendarMarker, filters: CalendarFilters): boolean {
  if (!kindVisible(filters, m.kind)) return false
  if (filters.projects.length === 0) return false
  if (!filters.projects.includes(m.project ?? '')) return false
  const q = filters.search.trim().toLowerCase()
  if (q) {
    const hay = `${m.label} ${m.detail ?? ''} ${m.project ?? ''}`.toLowerCase()
    if (!hay.includes(q)) return false
  }
  return true
}

function groupMarkers(markers: CalendarMarker[]): DayGroup[] {
  const byKind: Record<CalendarMarkerKind, DayGroup> = {
    daily: { kind: 'daily', count: 0, labels: [] },
    weekly: { kind: 'weekly', count: 0, labels: [] },
    monthly: { kind: 'monthly', count: 0, labels: [] },
    other: { kind: 'other', count: 0, labels: [] },
    run: { kind: 'run', count: 0, labels: [] },
  }
  for (const m of markers) {
    const g = byKind[m.kind] ?? byKind.other
    g.count += 1
    g.labels.push(m.label)
  }
  return Object.values(byKind).filter((g) => g.count > 0)
}

interface ScheduleCalendarProps {
  viewDate?: Date
  onViewDateChange?: (date: Date) => void
  markersByDate?: Record<string, CalendarMarker[]>
  repos?: string[]
  projectName?: string
  defaultFilters?: Partial<CalendarFilters>
  onAddDate?: (date: Date) => void
  onGoToSession?: (marker: CalendarMarker) => void
  className?: string
}

const KIND_ABBR: Record<CalendarMarkerKind, string> = {
  daily: 'D',
  weekly: 'W',
  monthly: 'M',
  other: 'O',
  run: 'R',
}

const MAX_BADGES = 3

export function ScheduleCalendar({
  viewDate,
  onViewDateChange,
  markersByDate = {},
  repos = [],
  projectName,
  defaultFilters,
  onAddDate,
  onGoToSession,
  className,
}: ScheduleCalendarProps) {
  const [internalView, setInternalView] = useState(() => new Date())
  const effectiveView = viewDate ?? internalView
  const setView = (d: Date) => {
    if (onViewDateChange) onViewDateChange(d)
    else setInternalView(d)
  }
  const shiftMonth = (delta: number) => {
    setView(new Date(effectiveView.getFullYear(), effectiveView.getMonth() + delta, 1))
  }

  const [filters, setFilters] = useState<CalendarFilters>(() => {
    const base = { ...defaultCalendarFilters(), ...defaultFilters }
    if (base.projects.length === 0) {
      base.projects = projectName ? [projectName] : repos.length > 0 ? [...repos] : []
    }
    return base
  })

  const [pickOpen, setPickOpen] = useState(false)
  const [detailKey, setDetailKey] = useState<string | null>(null)

  const days = useMemo(() => buildDayGrid(effectiveView), [effectiveView])
  const today = dateKey(new Date())
  const title = effectiveView.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
  })

  const [pickYear, setPickYear] = useState(() => effectiveView.getFullYear())

  const openPicker = () => {
    setPickYear(effectiveView.getFullYear())
    setPickOpen(true)
  }

  const applyPicker = (year: number, month: number) => {
    setView(new Date(year, month, 1))
    setPickOpen(false)
  }

  const MONTH_NAMES = useMemo(
    () => Array.from({ length: 12 }, (_, i) => new Date(2020, i, 1).toLocaleString(undefined, { month: 'short' })),
    [],
  )

  const detailMarkers = detailKey ? (markersByDate[detailKey] ?? []).filter((m) => markerVisible(m, filters)) : []
  const detailDate = detailKey ? days.find((d) => d.key === detailKey) : undefined

  const toggleFilterKind = (key: 'daily' | 'weekly' | 'monthly' | 'other' | 'run') => {
    setFilters((f) => ({ ...f, [key]: !f[key] }))
  }

  const kindChip = (key: 'daily' | 'weekly' | 'monthly' | 'other' | 'run', label: string) => (
    <button
      key={key}
      type="button"
      onClick={() => toggleFilterKind(key)}
      className={cn(
        'text-[10px] px-1.5 py-0.5 rounded border transition-colors leading-none',
        filters[key]
          ? `${KIND_BADGE[key]} border`
          : 'border-border text-muted-foreground/50 hover:text-muted-foreground',
      )}
    >
      {label}
    </button>
  )

  return (
    <div className={cn('rounded-lg border border-border bg-card p-2', className)}>
      <div className="flex items-center justify-between mb-2 relative">
        <button
          type="button"
          onClick={() => shiftMonth(-1)}
          className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          title="Previous month"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={openPicker}
          className="text-xs font-semibold text-foreground px-1 py-0.5 rounded hover:bg-muted transition-colors"
          title="Pick a month"
        >
          {title} <ChevronDown className="w-3 h-3 inline-block text-muted-foreground" />
        </button>
        <button
          type="button"
          onClick={() => shiftMonth(1)}
          className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          title="Next month"
        >
          <ChevronRight className="w-3.5 h-3.5" />
        </button>
        {pickOpen && (
          <div className="absolute top-full right-1/2 translate-x-1/2 z-20 mt-1 rounded-lg border border-border bg-background shadow-lg p-2 w-48">
            <div className="flex items-center justify-between mb-2">
              <button
                type="button"
                onClick={() => setPickYear((y) => y - 1)}
                className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                title="Previous year"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
              </button>
              <span className="text-xs font-semibold">{pickYear}</span>
              <button
                type="button"
                onClick={() => setPickYear((y) => y + 1)}
                className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                title="Next year"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="grid grid-cols-4 gap-1">
              {MONTH_NAMES.map((name, m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => applyPicker(pickYear, m)}
                  className={cn(
                    'rounded-md py-1 text-[11px] transition-colors',
                    pickYear === effectiveView.getFullYear() && m === effectiveView.getMonth()
                      ? 'bg-primary text-primary-foreground font-semibold'
                      : 'text-foreground hover:bg-muted',
                  )}
                >
                  {name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="grid grid-cols-7 text-center text-[10px] text-muted-foreground border border-border/60 rounded-t-md bg-muted/30">
        {WEEKDAYS.map((w) => (
          <div key={w} className="py-0.5 border-b border-border/60 [&+div]:border-l [&+div]:border-border/60">{w}</div>
        ))}
      </div>
      <div className="grid grid-cols-7 border border-border/60 rounded-b-md bg-border/60 gap-px overflow-hidden">
        {days.map((cell) => {
          const visible = (markersByDate[cell.key] ?? []).filter((m) => markerVisible(m, filters))
          const groups = groupMarkers(visible)
          const isToday = cell.key === today
          const isDetail = cell.key === detailKey
          return (
            <div
              key={cell.key}
              className={cn(
                'flex flex-col items-start bg-card py-1 h-[56px] transition-colors cursor-pointer overflow-hidden',
                cell.inCurrentMonth ? 'text-foreground' : 'text-muted-foreground/50',
                isDetail ? 'ring-1 ring-primary bg-primary/10' : 'hover:bg-muted/60',
              )}
              onClick={() => setDetailKey((prev) => (prev === cell.key ? null : cell.key))}
            >
              <div className="flex items-center justify-between w-full px-1">
                <span
                  className={cn(
                    'flex items-center justify-center h-5 w-5 rounded-full text-[11px]',
                    isToday && 'bg-primary text-primary-foreground font-semibold',
                  )}
                >
                  {cell.date.getDate()}
                </span>
                {onAddDate && (
                  <button
                    type="button"
                    title={`Add schedule on ${cell.date.toLocaleDateString()}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      onAddDate(cell.date)
                    }}
                    className="relative flex items-center justify-center h-3 w-3 rounded-full border border-border/60 text-muted-foreground/40 hover:text-muted-foreground/70 hover:border-muted-foreground/50 transition-colors"
                  >
                    <span className="absolute h-px w-[7px] bg-current rounded-full" />
                    <span className="absolute h-[7px] w-px bg-current rounded-full" />
                  </button>
                )}
              </div>
              {groups.length > 0 && (
                <span className="grid grid-cols-2 w-full mt-0.5 px-[2px] gap-[1px]">
                  {groups.map((g) => (
                    <span
                      key={g.kind}
                      className={cn(
                        'rounded border text-center truncate leading-none min-w-0',
                        visible.length > MAX_BADGES
                          ? 'text-[7px] px-[2px] py-[1px] min-h-[10px]'
                          : 'text-[7px] px-[3px] py-[1px]',
                        KIND_BADGE[g.kind],
                      )}
                      title={`${KIND_LABEL[g.kind]} ${g.count}`}
                    >
                      {KIND_ABBR[g.kind]} {g.count}
                    </span>
                  ))}
                </span>
              )}
            </div>
          )
        })}
      </div>

      <div className="mt-2 space-y-1.5">
        <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  'flex items-center gap-1 px-1.5 py-0.5 rounded border transition-colors leading-none max-w-[180px]',
                  filters.projects.length > 0
                    ? 'border-primary/50 text-primary bg-primary/10'
                    : 'border-border text-muted-foreground/50 hover:text-muted-foreground',
                )}
                title="Filter by project"
              >
                <span className="truncate">
                  {filters.projects.length === 0
                    ? 'Select project'
                    : filters.projects.length === 1
                      ? filters.projects[0]
                      : `${filters.projects.length} selected`}
                </span>
                <ChevronDown className="w-2.5 h-2.5 shrink-0" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-64 overflow-y-auto min-w-[160px]">
              <DropdownMenuLabel>Projects</DropdownMenuLabel>
              <DropdownMenuCheckboxItem
                checked={repos.length > 0 && repos.every((r) => filters.projects.includes(r))}
                onCheckedChange={() => {
                  const allSelected = repos.length > 0 && repos.every((r) => filters.projects.includes(r))
                  setFilters((f) => ({ ...f, projects: allSelected ? [] : [...repos] }))
                }}
              >
                All projects
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              {repos.map((repo) => (
                <DropdownMenuCheckboxItem
                  key={repo}
                  checked={filters.projects.includes(repo)}
                  onCheckedChange={(checked) =>
                    setFilters((f) => ({
                      ...f,
                      projects: checked ? [...f.projects, repo] : f.projects.filter((p) => p !== repo),
                    }))
                  }
                >
                  {repo}
                </DropdownMenuCheckboxItem>
              ))}
              {repos.length === 0 && <DropdownMenuItem disabled>No repos</DropdownMenuItem>}
            </DropdownMenuContent>
          </DropdownMenu>
          {kindChip('daily', 'Daily')}
          {kindChip('weekly', 'Weekly')}
          {kindChip('monthly', 'Monthly')}
          {kindChip('other', 'Other')}
          {kindChip('run', 'Run')}
        </div>
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground" />
          <Input
            type="text"
            value={filters.search}
            onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
            placeholder="Search schedules..."
            className="pl-6 h-7 text-[11px]"
          />
        </div>
      </div>

      {detailKey && (
        <div className="mt-2 rounded-lg border border-border bg-card">
          <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-border">
            <p className="text-[11px] font-semibold text-foreground">
              {detailDate ? detailDate.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', weekday: 'short' }) : detailKey}
              {' · '}
              <span className="font-normal text-muted-foreground">{detailMarkers.length} item{detailMarkers.length === 1 ? '' : 's'}</span>
            </p>
            <button
              type="button"
              onClick={() => setDetailKey(null)}
              className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
              title="Close"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="p-2 space-y-1.5">
            {detailMarkers.length === 0 ? (
              <p className="text-[11px] text-muted-foreground text-center py-3">No matching schedules on this day.</p>
            ) : (
            detailMarkers.map((m) => (
              <div key={m.id} className="flex items-center gap-1.5 text-[11px] text-foreground min-w-0">
                <span className={`px-1 py-[1px] rounded border text-[9px] leading-none shrink-0 min-w-fit ${KIND_BADGE[m.kind] ?? ''}`}>
                  {KIND_LABEL[m.kind] ?? m.kind}
                </span>
                <span className="truncate">{m.label}</span>
                {m.detail && <span className="font-mono text-[10px] text-muted-foreground/70 truncate shrink-0 max-w-[45%]">{m.detail}</span>}
                {m.repoName && <span className="text-[9px] font-semibold text-muted-foreground/70 shrink-0 truncate max-w-[100px]">{m.repoName}</span>}
                {m.kind === 'run' && m.sessionTitle && (
                  <span className="text-[9px] text-muted-foreground/70 shrink-0 truncate max-w-[110px]">{m.sessionTitle}</span>
                )}
                {m.kind === 'run' && m.sessionID && onGoToSession && (
                  <button
                    type="button"
                    onClick={() => onGoToSession(m)}
                    className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors shrink-0"
                    title="Open session"
                  >
                    <CornerDownLeft className="w-3 h-3" />
                  </button>
                )}
              </div>
            ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}