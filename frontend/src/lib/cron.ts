function expandField(field: string, min: number, max: number): number[] | null {
  const values = new Set<number>()
  for (const part of field.split(',')) {
    const stepMatch = part.match(/^([\d*]+)(?:-(\d+))?(?:\/(\d+))?$/)
    if (!stepMatch) return null

    const startRaw = stepMatch[1]
    const endRaw = stepMatch[2]
    const stepRaw = stepMatch[3]
    if (!startRaw) return null
    const step = stepRaw ? parseInt(stepRaw, 10) : 1
    if (step < 1) return null

    const start = startRaw === '*' ? min : parseInt(startRaw, 10)
    const end = endRaw
      ? parseInt(endRaw, 10)
      : stepRaw
        ? max
        : startRaw === '*' ? max : start

    for (let v = start; v <= end; v += step) {
      if (v >= min && v <= max) values.add(v)
    }
  }
  return values.size > 0 ? [...values] : null
}

export type CronScheduleKind = 'daily' | 'weekly' | 'monthly' | 'other'

export function cronScheduleKind(cron: string): CronScheduleKind {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return 'other'
  const day = parts[2]
  const weekday = parts[4]
  if (!day || !weekday) return 'other'

  const isAsterisk = (field: string) => field === '*' || field === ''
  const dayAll = isAsterisk(day)
  const weekdayAll = isAsterisk(weekday)

  if (dayAll && weekdayAll) return 'daily'
  if (dayAll && !weekdayAll) return 'weekly'
  if (!dayAll && weekdayAll) return 'monthly'
  return 'other'
}

export function cronMatchesDate(cron: string, date: Date): boolean {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return false

  const minute = parts[0]
  const hour = parts[1]
  const day = parts[2]
  const month = parts[3]
  const weekday = parts[4]
  if (!minute || !hour || !day || !month || !weekday) return false

  const days = expandField(day, 1, 31)
  const months = expandField(month, 1, 12)
  const weekdays = expandField(weekday, 0, 6)

  if (!days || !months || !weekdays) return false

  return (
    days.includes(date.getDate()) &&
    months.includes(date.getMonth() + 1) &&
    weekdays.includes(date.getDay())
  )
}

export function dateKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export interface CalendarRange {
  start: Date
  end: Date
}

// 6-week window (42 cells): starts on the Sunday on/before the 1st of the
// current month, so the first row shows the tail of the previous month when
// the 1st is not a Sunday. Covers the current month plus the first week of
// the following month.
export function monthCalendarRange(now: Date): CalendarRange {
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
  const start = new Date(firstOfMonth)
  start.setDate(start.getDate() - start.getDay())
  const end = new Date(start)
  end.setDate(end.getDate() + 41)
  return { start, end }
}

export function scheduleFiresInWindow(
  cron: string,
  registeredAt?: number,
  activeFrom?: number,
  activeUntil?: number,
): (date: Date) => boolean {
  const startDay = activeFrom ? new Date(activeFrom) : null
  const endDay = activeUntil ? new Date(activeUntil) : null
  const registeredDay = registeredAt ? new Date(registeredAt) : null
  const startKey = startDay ? dateKey(startDay) : null
  const endKey = endDay ? dateKey(endDay) : null
  const registeredKey = registeredDay ? dateKey(registeredDay) : null
  return (date) => {
    if (!cronMatchesDate(cron, date)) return false
    const k = dateKey(date)
    if (registeredKey && k < registeredKey) return false
    if (startKey && k < startKey) return false
    if (endKey && k > endKey) return false
    return true
  }
}