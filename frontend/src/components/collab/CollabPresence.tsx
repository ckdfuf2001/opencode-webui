import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { activityLabel, peerActivity, type Peer } from '@/lib/usePeers'

/**
 * C1: 접속자 표시 통일 (PPT/XLSX 공용).
 *
 * - 이 파일이 참가자 표시의 단일 출처다. PPT(PptxViewer)와 XLSX(DocumentPreview)가
 *   같은 마크업·같은 testid(`collab-presence`, `collab-peer`)로 그린다.
 * - 시각 갱신은 NowProvider 컨텍스트로만 전파한다. 칩만 다시 그려지고
 *   뷰어(덱 트리·그리드)는 다시 그려지지 않는다 (M7-2).
 */

/**
 * M7-2: 1초마다 갱신되는 시각 컨텍스트.
 *
 * "N초 전 편집" 같은 상대 시간과 data-activity가 매초 바뀌어야 하는데,
 * 그 갱신을 뷰어가 감으면 덱 트리 전체가 리렌더된다(24슬라이드 SVG → 레이아웃
 * 객체가 GC를 기다리며 렌더러 메모리 증가). 그래서 시각을 컨텍스트로 내보내고
 * **그 값을 쓰는 칩 컴포넌트만** 다시 그리게 한다.
 */
const NowCtx = createContext(0)

export function NowProvider({ children, active = false }: { children: ReactNode; active?: boolean }): ReactNode {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    // 아무도 편집 중이 아니면 상대 시간 표시가 바뀔 일이 없으므로 느리게 돌린다.
    // (유휴 상태 interval 실행 횟수를 M7-4 기준으로 낮추기 위함)
    const ms = active ? 1000 : 5000
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [active])
  return <NowCtx.Provider value={now}>{children}</NowCtx.Provider>
}

/**
 * M7-2: 참가자 칩. 시각만 컨텍스트로 받아 자기 자신만 다시 그린다.
 * (뷰어가 매초 리렌더되면 덱 트리 전체가 리렌더된다)
 */
export function CollabPeerChip({ p, following, onFollow }: { p: Peer; following: boolean; onFollow: () => void }): ReactNode {
  const now = useContext(NowCtx)
  const act = peerActivity(p, now)
  const status = act === 'idle' ? '' : activityLabel(p, now)
  return (
    <button
      type="button"
      data-testid="collab-peer"
      data-peer-id={p.id}
      data-mode={p.mode}
      {...(typeof p.slide === 'number' ? { 'data-slide': p.slide } : {})}
      data-owner={p.isOwner ? 'true' : 'false'}
      data-self="false"
      data-activity={act}
      data-following={following ? 'true' : 'false'}
      {...(p.selectedLabel ? { 'data-selected-label': p.selectedLabel } : {})}
      title={following ? `${p.name} 팔로우 중 (클릭하면 해제)` : `${p.name} 팔로우`}
      aria-pressed={following}
      onClick={onFollow}
      className={`inline-flex items-center gap-1 shrink-0 hover:text-foreground${
        following ? ' underline decoration-dotted underline-offset-2' : ''
      }`}
    >
      <span
        className={`inline-block w-2 h-2 rounded-full${act === 'editing' ? ' animate-pulse' : ''}`}
        style={act === 'editing' ? { backgroundColor: p.color } : { border: `1.5px solid ${p.color}` }}
      />
      <span>
        {p.name}
        {p.tabCount > 1 ? ` (${p.tabCount}탭)` : ''}
        {p.device === 'mobile' ? '📱' : ''}
        {/* 위치 글자는 화면에 띄우지 않는다. 위치 표시는 lib 자체 표시
        (좌측 썸네일 하이라이트) 하나만 남긴다.
        app.slide / data-slide는 그대로 유지 — 보이지 않지만 테스트가 읽는다. */}
        {status ? ` · ${status}` : ''}
      </span>
    </button>
  )
}

/**
 * M7-2: 자기 상태 마커(숨김, 진단/테스트용). data-activity가 실시간이어야 해서
 * 시각 컨텍스트만 구독한다.
 */
export function CollabSelfMarker({ peer }: { peer: Peer }): ReactNode {
  const now = useContext(NowCtx)
  return (
    <span
      data-testid="collab-peer"
      data-peer-id={peer.id}
      data-mode={peer.mode}
      data-owner={peer.isOwner ? 'true' : 'false'}
      data-self="true"
      data-activity={peerActivity(peer, now)}
      className="hidden"
    />
  )
}

/**
 * C1: 통합 presence 컨테이너. testid `collab-presence`가 C1의 존재 단언이다.
 * 기존 `collab-presence-bar`(E11m 회귀)는 안쪽에 그대로 둔다.
 */
export function CollabPresenceShell({ children }: { children: ReactNode }): ReactNode {
  return <div data-testid="collab-presence">{children}</div>
}
