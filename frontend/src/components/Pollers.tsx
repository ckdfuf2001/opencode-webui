import { useOpencodeHealth } from '@/hooks/useOpencodeHealth'
import { useSessionStatusMap } from '@/hooks/useOpenCode'

/**
 * M7-4 (d) 단일 폴러.
 *
 * 세션 상태(1200ms busy / 5000ms idle)와 백엔드 헬스(3000ms)를 폴링하는 곳은
 * 이 컴포넌트 하나뿐이다. 나머지 컴포넌트는 같은 query key의 캐시만 읽는다.
 *
 * 왜: 이전에는 useSessionStatusMap/useOpencodeHealth를 쓰는 컴포넌트마다
 * 타이머가 따로 있어 유휴 상태에서도 초당 수 번 폴링이 돌았고, 그 결과가
 * 문서 뷰어 렌더러 메모리 증가의 절반을 차지했다(편집 모드 +0.42MB/s 중
 * 폴링이 약 +0.22MB/s, M7-4 2절 E-a vs E-b 실측).
 */
export function Pollers() {
  useSessionStatusMap({ poll: true })
  useOpencodeHealth({ poll: true })
  return null
}