import { useEffect, useMemo } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  listNotifyOverrides,
  setNotifyOverride as apiSet,
  type NotifyOverride,
  type NotifyOverridePatch,
  type NotifyScope,
} from '@/api/notify'
import {
  legacyOverrideSource,
  readLegacyRepoOverrides,
  readLegacySessionOverrides,
  clearLegacyNotifyOverrides,
  type OverrideSource,
} from '@/lib/notifications'

export const notifyOverridesKey = ['notify-overrides'] as const

const MIGRATION_FLAG = 'opencode-notify-migrated-v1'

function toSource(list: NotifyOverride[] | undefined): OverrideSource {
  if (!list || list.length === 0) return legacyOverrideSource
  const sessions = new Map<string, NotifyOverride>()
  const repos = new Map<string, NotifyOverride>()
  for (const o of list) {
    if (o.scope === 'session') sessions.set(o.target, o)
    else repos.set(String(o.target), o)
  }
  if (sessions.size === 0 && repos.size === 0) return legacyOverrideSource
  return {
    session: (sessionId: string) => sessions.get(sessionId) ?? legacyOverrideSource.session(sessionId),
    repo: (repoId: number | string) => repos.get(String(repoId)) ?? legacyOverrideSource.repo(repoId),
  }
}

export function useNotifyOverrides() {
  return useQuery({
    queryKey: notifyOverridesKey,
    queryFn: listNotifyOverrides,
    staleTime: 30_000,
  })
}

/** 백단 캐시 우선, 비어 있으면 레거시 localStorage 폴백. */
export function useOverrideSource(): OverrideSource {
  const { data } = useNotifyOverrides()
  return useMemo(() => toSource(data), [data])
}

export function useSetNotifyOverride() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ scope, target, patch }: { scope: NotifyScope; target: string; patch: NotifyOverridePatch }) =>
      apiSet(scope, target, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: notifyOverridesKey })
    },
  })
}

function hasAnyField(patch: NotifyOverridePatch): boolean {
  return (
    patch.pushEnabled !== undefined ||
    patch.soundEnabled !== undefined ||
    patch.soundOnCancelEnabled !== undefined ||
    patch.skillAutoEnabled !== undefined ||
    patch.skillReviewEnabled !== undefined
  )
}

/** localStorage 레거시 값을 백단으로 1회 이전한다. */
export function useNotifyMigration() {
  const queryClient = useQueryClient()
  useEffect(() => {
    let cancelled = false
    try {
      if (localStorage.getItem(MIGRATION_FLAG)) return
    } catch {
      return
    }
    void (async () => {
      try {
        const jobs: Array<Promise<unknown>> = []
        for (const [sessionId, patch] of Object.entries(readLegacySessionOverrides())) {
          if (!hasAnyField(patch)) continue
          jobs.push(apiSet('session', sessionId, patch))
        }
        for (const [repoId, patch] of Object.entries(readLegacyRepoOverrides())) {
          if (!hasAnyField(patch)) continue
          jobs.push(apiSet('repo', String(repoId), patch))
        }
        if (jobs.length > 0) await Promise.all(jobs)
        if (cancelled) return
        try {
          clearLegacyNotifyOverrides()
          localStorage.setItem(MIGRATION_FLAG, '1')
        } catch {}
        queryClient.invalidateQueries({ queryKey: notifyOverridesKey })
      } catch {
        // 실패 시 키를 남겨 다음 로드 때 재시도
      }
    })()
    return () => {
      cancelled = true
    }
  }, [queryClient])
}
