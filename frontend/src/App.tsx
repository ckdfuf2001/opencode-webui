import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom'
import { Toaster } from 'sonner'
import { Repos } from './pages/Repos'
import { RepoDetail } from './pages/RepoDetail'
import { SessionDetail } from './pages/SessionDetail'
import { Search } from './pages/Search'
import { ExposeCommands } from './pages/ExposeCommands'
import { SettingsDialog } from './components/settings/SettingsDialog'
import { useSettingsDialog } from './hooks/useSettingsDialog'
import { useTheme } from './hooks/useTheme'
import { useNotifyMigration } from './hooks/useNotifyOverrides'
import { useReleaseCacheOnHidden } from './hooks/useOpenCode'
import { useEffect } from 'react'
import { BUILD_LABEL, logBuildInfo } from './lib/build-info'
import { HtmlViewerMenu } from './components/html/HtmlViewerMenu'
import { FavoriteSessionsPanel } from './components/favorites/FavoriteSessionsPanel'

// 자동승인은 백단이 전담한다 (세션 룰 포함 — 탭 닫힘과 무관).

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 10,
      // 미사용 쿼리는 10초 뒤 메모리에서 제거 — pnpm 등 대량 툴 출력이 30초 동안 힙을 잡아 3GB까지 가던 원인, 프론트만 돌려도 동일
      gcTime: 1000 * 10,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
    },
  },
})

function AppContent() {
  const { isOpen, close } = useSettingsDialog()
  useTheme()
  useReleaseCacheOnHidden()
  // 레거시 localStorage 알림 설정을 백단으로 1회 이전
  useNotifyMigration()
  useEffect(() => { logBuildInfo() }, [])
  // 전역 Esc: 채팅창 외에서는 열려있는 패널(즐찾/html/workspace/탐색기 등) 모두 닫기 — 레포/세션 리스트에서도 동작해야 하므로 App 레벨에서 처리
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return
      if (e.defaultPrevented) return
      const ae = document.activeElement as HTMLElement | null
      if (ae?.getAttribute('data-prompt-input') === 'true') return
      const editor = document.querySelector('[data-file-editor="true"]')
      if (editor && document.activeElement === editor) return
      window.dispatchEvent(new CustomEvent('global-escape-close'))
      e.preventDefault()
    }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [])

  return (
    <BrowserRouter>
      <AppRoutesWithPanels isOpen={isOpen} close={close} />
    </BrowserRouter>
  )
}

function AppRoutesWithPanels({ isOpen, close }: { isOpen: boolean; close: () => void }) {
  const location = useLocation()
  const isExpose = location.pathname === '/expose'
  return (
    <>
      <div className="pointer-events-none fixed bottom-1 right-2 z-[5] text-[10px] text-muted-foreground/50 select-none" title="build">
        {BUILD_LABEL}
      </div>
      <Routes>
        <Route path="/" element={<Repos />} />
        <Route path="/search" element={<Search />} />
        <Route path="/expose" element={<ExposeCommands />} />
        <Route path="/repos/:id" element={<RepoDetail />} />
        <Route path="/repos/:id/sessions/:sessionId" element={<SessionDetail />} />
        <Route path="/session/:sessionId" element={<SessionDetail />} />
      </Routes>
      <SettingsDialog open={isOpen} onOpenChange={close} />
      {!isExpose && <FavoriteSessionsPanel />}
      {!isExpose && <HtmlViewerMenu />}
      <Toaster
        position="bottom-right"
        expand={false}
        richColors
        closeButton
      />
    </>
  )
}

function App() {

  return (
    <QueryClientProvider client={queryClient}>
      <AppContent />
    </QueryClientProvider>
  )
}

export default App
