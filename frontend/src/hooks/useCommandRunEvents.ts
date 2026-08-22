import { useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { API_BASE_URL } from '@/config'

/**
 * 백엔드 pre/post 커맨드 훅에서 밀어주는 run 라이프사이클 SSE를 구독해
 * 커맨드 히스토리 관련 캐시를 즉시 무효화한다(앱 전역에서 단일 연결).
 *
 * 재연결은 브라우저 EventSource의 네이티브 동작에 맡긴다. 끊어졌을 때만
 * 자체 백오프로 재시도하며, 정상 상태에서는 heartbeat 외 트래픽이 없다.
 */
export function useCommandRunEvents() {
  const queryClient = useQueryClient()

  useEffect(() => {
    const source = new EventSource(`${API_BASE_URL}/api/command-runs/events`)
    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as { type?: string }
        if (payload.type !== 'command-run') return
        void queryClient.invalidateQueries({ queryKey: ['command-runs'] })
      } catch {
        // heartbeat 주석 등은 무시
      }
    }
    return () => source.close()
  }, [queryClient])
}
