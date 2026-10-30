import type { Peer } from '@/lib/usePeers'

/**
 * 아바타·팝오버 표시용 뷰 모델과 순수 헬퍼.
 * CollabPresence.tsx(컴포넌트 전용, react-refresh 규칙)와 분리한다.
 */

export interface PresencePeerView {
  id: string
  name: string
  color: string
  mode: 'view' | 'edit'
  isSelf: boolean
  isOwner: boolean
  tabCount: number
  device?: 'mobile' | 'desktop'
  slide?: number
  sheetIndex?: number
  range?: string
  selectedLabel?: string
  lastEditAt?: number
  selectedId?: string
}

/**
 * "(Me)"는 표시 전용 접미사. 저장값(localStorage)·presence·서버에는 붙이지 않는다.
 * i18n을 붙일 때 여기만 바꾼다.
 */
export const SELF_SUFFIX = ' (Me)'

/** 표시용 이름. 내 행에만 "(Me)"를 붙인다. */
export function displayName(p: Pick<PresencePeerView, 'name' | 'isSelf' | 'tabCount'>): string {
  const base = `${p.name}${p.isSelf ? SELF_SUFFIX : ''}`;
  return p.tabCount > 1 ? `${base} · 탭 ${p.tabCount}` : base;
}

export function peerToView(p: Peer): PresencePeerView {
  return {
    id: p.id,
    name: p.name,
    color: p.color,
    mode: p.mode,
    isSelf: p.isSelf,
    isOwner: p.isOwner,
    tabCount: p.tabCount,
    device: p.device,
    slide: p.slide,
    selectedLabel: p.selectedLabel,
    lastEditAt: p.lastEditAt,
    selectedId: p.selectedId,
  }
}

/** 이니셜 (아바타 원 안에). 이름 앞 2글자까지. */
export function peerInitials(name: string): string {
  const t = name.trim()
  if (!t) return '?'
  const parts = t.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) return ((parts[0]![0] ?? '') + (parts[1]![0] ?? '')).toUpperCase()
  return t.slice(0, 2).toUpperCase()
}
