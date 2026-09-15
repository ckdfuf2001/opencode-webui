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
import { startAutoApprover } from './hooks/useAutoApprovePermissions'
import { useSettings } from './hooks/useSettings'
import { isPushSupported, ensurePushPermission, sendPushNotification } from './lib/notifications'
import { useState, useEffect } from 'react'
import { Button } from './components/ui/button'
import { Bell } from 'lucide-react'
import { BUILD_LABEL, logBuildInfo } from './lib/build-info'
import { HtmlViewerMenu } from './components/html/HtmlViewerMenu'
import { FavoriteSessionsPanel } from './components/favorites/FavoriteSessionsPanel'

startAutoApprover()

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

function PushPrompt() {
  const { preferences, isLoading, updateSettings } = useSettings()
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (isLoading || !preferences) return
    if (!isPushSupported()) return
    // 이미 앱에서 허용됨 — 배너 표시 안 함
    if (preferences.pushNotificationEnabled === true) { setVisible(false); return }
    // 브라우저에서 이미 허용/거부됨 — 배너 표시 안 함
    if (typeof Notification !== 'undefined' && Notification.permission !== 'default') { setVisible(false); return }
    if (localStorage.getItem('opencode-push-prompt-dismissed')) return
    // 즉시 표시 (유튜브처럼 첫 방문 시 배너)
    setVisible(true)
  }, [isLoading, preferences])
  // 렌더 시점에서도 허용 상태면 즉시 숨김 (effect 지연으로 인한 깜빡임 방지)
  if (preferences?.pushNotificationEnabled === true) return null
  if (typeof window !== 'undefined' && typeof Notification !== 'undefined' && Notification.permission !== 'default') return null
  if (!visible) return null
  return (
    <div className="fixed top-0 left-0 right-0 z-[100] bg-amber-500 border-b border-amber-600 px-4 py-3 flex items-center justify-between gap-3 shadow-lg">
      <div className="flex items-center gap-2 text-sm text-white">
        <Bell className="w-4 h-4" />
        <span>PC 알림을 허용하면 응답 완료·권한 요청을 OS 알림으로 받을 수 있습니다. 브라우저 허용 팝업이 뜹니다.</span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button variant="outline" size="sm" className="h-7 text-xs bg-white text-amber-700 hover:bg-amber-50" onClick={() => { localStorage.setItem('opencode-push-prompt-dismissed','1'); setVisible(false); }}>나중에</Button>
        <Button size="sm" className="h-7 text-xs bg-white text-amber-700 hover:bg-amber-100 font-bold" onClick={async () => {
          const perm = await ensurePushPermission()
          if (perm === 'granted') {
            updateSettings({ pushNotificationEnabled: true })
            void sendPushNotification('알림 허용됨', { body: '이제 PC 알림을 받을 수 있습니다.', tag: 'push-enabled' })
            setVisible(false)
          } else if (perm === 'denied') {
            localStorage.setItem('opencode-push-prompt-dismissed','1')
            setVisible(false)
          } else {
            setVisible(false)
          }
        }}>허용</Button>
      </div>
    </div>
  )
}

function AppContent() {
  const { isOpen, close } = useSettingsDialog()
  useTheme()
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
  const { preferences } = useSettings()
  const favoritesEnabled = preferences?.favoritesEnabled ?? false
  // 즐겨찾기를 끄면 목록 캐시를 즉시 비워 메모리를 되돌린다
  useEffect(() => {
    if (!favoritesEnabled) queryClient.removeQueries({ queryKey: ['favorites'] })
  }, [favoritesEnabled])
  return (
    <>
      <PushPrompt />
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
      {!isExpose && favoritesEnabled && <FavoriteSessionsPanel />}
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
