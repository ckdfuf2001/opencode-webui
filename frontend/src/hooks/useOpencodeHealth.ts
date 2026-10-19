import { useQuery } from '@tanstack/react-query'
import { API_BASE_URL } from '@/config'
import { pollDisabled } from '@/lib/pollSwitch'

/**
 * 백엔드헬스 조회.
 *
 * M7-4 (d) 단일 폴러: 폴링은 App의 <HealthPoller> 하나만 한다.
 * 나머지 호출부는 캐시만 읽는다(기본 폴링 없음).
 * 연결 표시(초록/주황)는 이 값 하나로 판단하므로 폴러 1개면 충분하다.
 */
export function useOpencodeHealth(opts?: { poll?: boolean }) {
  const poll = opts?.poll === true && !pollDisabled()
  return useQuery({
    queryKey: ['opencode-health'],
    queryFn: async () => {
      const res = await fetch(`${API_BASE_URL}/api/health`)
      if (!res.ok) throw new Error('health check failed')
      const data = await res.json() as { opencode: string; status: string }
      return data.opencode === 'healthy' && data.status !== 'unhealthy'
    },
    refetchInterval: poll ? 3000 : false,
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
