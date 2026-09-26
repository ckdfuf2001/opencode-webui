import axios from 'axios'
import { API_BASE_URL } from '@/config'

/**
 * provider 등록/삭제는 opencode 재시동을 유발한다 (provider 레지스트리가 부팅
 * 시에 만들어지고, PATCH /config 는 provider 변경을 거부한다). 재시동 동안
 * opencode 는 응답하지 않아, 그 창에 모델을 보내면 실패하고 프론트가 캐시한
 * provider/모델 목록도 비어 보인다.
 *
 * 그래서 변경 직후엔 재시동이 끝날 때까지 기다렸다가 새로고침한다.
 * 기다리지 않고 새로고침하면 여전히 죽은 opencode 를 보고 빈 목록을 캐시한다.
 */
export async function waitForOpencodeHealthy(timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  // 첫 확인 전 잠깐 — 재시동이 시작되기 전 healthy 를 보고 즉시 통과하는 것 방지
  await sleep(500)
  while (Date.now() < deadline) {
    try {
      const { data } = await axios.get(`${API_BASE_URL}/api/health`, { timeout: 5000 })
      if (data?.opencode === 'healthy') return true
    } catch {
      // 재시동 중 — 계속 시도
    }
    await sleep(1500)
  }
  return false
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
