export type ScheduleAction = 'command' | 'chat'

export interface Schedule {
  id: number
  repoId: number
  name: string
  action: ScheduleAction
  command?: string
  prompt?: string
  cron: string
  enabled: boolean
  lastRunAt?: number
  activeFrom?: number
  activeUntil?: number
  agent?: string
  createdAt: number
  updatedAt: number
}

export interface CreateScheduleInput {
  repoId: number
  name: string
  action: ScheduleAction
  command?: string
  prompt?: string
  cron: string
  enabled?: boolean
  activeFrom?: number
  activeUntil?: number
  agent?: string
}

export interface UpdateScheduleInput {
  name?: string
  action?: ScheduleAction
  command?: string
  prompt?: string
  cron?: string
  enabled?: boolean
  activeFrom?: number
  activeUntil?: number
  agent?: string
}
