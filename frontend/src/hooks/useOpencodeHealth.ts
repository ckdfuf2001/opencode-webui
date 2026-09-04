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
