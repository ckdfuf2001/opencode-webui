import type { CronScheduleKind } from '@/lib/cron'

export type CalendarMarkerKind = CronScheduleKind | 'run'

export interface CalendarMarker {
  id: string
  label: string
  kind: CalendarMarkerKind
  detail?: string
  project?: string
  sessionID?: string
  messageID?: string
  repoId?: number
  repoName?: string
  sessionTitle?: string
}

export interface CalendarFilters {
  projects: string[]
  daily: boolean
  weekly: boolean
  monthly: boolean
  other: boolean
  run: boolean
  search: string
}

export const defaultCalendarFilters = (): CalendarFilters => ({
  projects: [],
  daily: true,
  weekly: true,
  monthly: true,
  other: true,
  run: true,
  search: '',
})

export const KIND_LABEL: Record<CalendarMarkerKind, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  monthly: 'Monthly',
  other: 'Other',
  run: 'Run',
}

export const KIND_BADGE: Record<CalendarMarkerKind, string> = {
  daily: 'bg-blue-500/15 text-blue-400 border-blue-500/40',
  weekly: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/40',
  monthly: 'bg-purple-500/15 text-purple-400 border-purple-500/40',
  other: 'bg-amber-500/15 text-amber-400 border-amber-500/40',
  run: 'bg-muted text-muted-foreground border-border',
}