import { create } from 'zustand'

interface FileTreeExpandStore {
  /** 수동 토글 기록 (키: baseKey + 경로, 값: 펼침 여부) */
  explicit: Map<string, boolean>
  setExplicit: (baseKey: string, path: string, expanded: boolean) => void
}

/**
 * 트리 펼침 상태 저장소.
 * 기존에는 TreeNode useState라 리마운트(시트 열고닫기·데이터 교체·파일 선택 등) 때마다
 * 수동 펼침이 날아가 트리가 다 닫혔다. 여기서 들고 있으면 마운트와 무관하게 유지된다.
 */
export const useFileTreeExpand = create<FileTreeExpandStore>((set) => ({
  explicit: new Map(),
  setExplicit: (baseKey, path, expanded) =>
    set((s) => {
      const next = new Map(s.explicit)
      next.set(`${baseKey}\n${path}`, expanded)
      // 무한 누적 방지 — 오래된 것부터 정리 (최근 2000개 유지)
      while (next.size > 2000) {
        const oldest = next.keys().next().value as string | undefined
        if (oldest === undefined) break
        next.delete(oldest)
      }
      return { explicit: next }
    }),
}))
