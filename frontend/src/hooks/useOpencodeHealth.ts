import { useQuery } from '@tanstack/react-query'
import { API_BASE_URL } from '@/config'

export function useOpencodeHealth() {
  return useQuery({
    queryKey: ['opencode-health'],
    queryFn: async () => {
      const res = await fetch(`${API_BASE_URL}/api/health`)
      if (!res.ok) throw new Error('health check failed')
      const data = await res.json() as { opencode: string; status: string }
      return data.opencode === 'healthy' && data.status !== 'unhealthy'
    },
    refetchInterval: 3000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
  })
}

export interface StatusQueryState {
  data?: unknown
  isError?: boolean
  isFetching?: boolean
  failureCount?: number
}

/**
 * 백엔드 연결 표시용 판정.
 * TanStack Query는 캐시가 있으면 백그라운드 재시도 실패해도 isError가 안 뜨고
 * 예전 data를 유지해서, isError만 보면 한 번 초록불이 들어온 뒤 영원히 안 꺼진다.
 * failureCount(연속 실패 횟수, 성공 시 0으로 리셋)를 같이 봐야 실제 연결이 보인다.
 */
export function useBackendConnection(statusQuery?: StatusQueryState): {
  connected: boolean
  reconnecting: boolean
} {
  const health = useOpencodeHealth()
  const healthFails = health.failureCount ?? 0
  const statusFails = statusQuery?.failureCount ?? 0
  const fails = healthFails + statusFails
  const healthOk = health.data === true && healthFails === 0
  const statusOk =
    !statusQuery?.isError && statusQuery?.data != null && statusFails === 0
  const connected = healthOk && (statusQuery ? statusOk : true)
  const reconnecting =
    !connected &&
    (health.isFetching || !!statusQuery?.isFetching || fails < 3)
  return { connected, reconnecting }
}
