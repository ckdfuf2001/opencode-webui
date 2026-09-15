import { create } from 'zustand'
import { normalizeTreePath } from '@/lib/tree-path'

interface ChatAttachedStore {
  /** 정규화된 첨부 경로 집합 (비교용) */
  attachedPaths: Set<string>
  /** 프롬프트의 첨부 전체를 교체한다 (PromptInput이 attachedFiles 변경 시 동기화) */
  setAttached: (paths: string[]) => void
}

export const useChatAttached = create<ChatAttachedStore>((set) => ({
  attachedPaths: new Set(),
  setAttached: (paths: string[]) => {
    const next = new Set<string>()
    for (const p of paths) {
      if (!p) continue
      // 무한 누적 방지 — 최근 200개만 유지
      if (next.size >= 200) break
      next.add(normalizeTreePath(p))
    }
    set({ attachedPaths: next })
  },
}))
