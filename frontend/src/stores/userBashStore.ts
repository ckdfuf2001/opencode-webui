import { create } from 'zustand'

interface UserBashStore {
  userBashCommands: Map<string, number> // command -> timestamp
  addUserBashCommand: (command: string) => void
}

export const useUserBash = create<UserBashStore>((set) => ({
  userBashCommands: new Map(),
  addUserBashCommand: (command: string) => {
    set((state) => {
      const newMap = new Map(state.userBashCommands)
      newMap.delete(command)
      newMap.set(command, Date.now())
      // 무한 누적 방지 — 최근 200개만 유지 (오래된 명령 판별에 불필요)
      while (newMap.size > 200) {
        const oldest = newMap.keys().next()
        if (oldest.done) break
        newMap.delete(oldest.value)
      }
      return { userBashCommands: newMap }
    })
  },
}))