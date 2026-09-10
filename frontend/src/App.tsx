import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Toaster } from 'sonner'
import { Repos } from './pages/Repos'
import { RepoDetail } from './pages/RepoDetail'
import { SessionDetail } from './pages/SessionDetail'
import { Search } from './pages/Search'
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

startAutoApprover()

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 30,
      gcTime: 1000 * 60 * 5,
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

  return (
    <BrowserRouter>
      <PushPrompt />
      <div className="pointer-events-none fixed bottom-1 right-2 z-[5] text-[10px] text-muted-foreground/50 select-none" title="build">
        {BUILD_LABEL}
      </div>
      <Routes>
        <Route path="/" element={<Repos />} />
        <Route path="/search" element={<Search />} />
        <Route path="/repos/:id" element={<RepoDetail />} />
        <Route path="/repos/:id/sessions/:sessionId" element={<SessionDetail />} />
        <Route path="/session/:sessionId" element={<SessionDetail />} />
      </Routes>
      <SettingsDialog open={isOpen} onOpenChange={close} />
      <HtmlViewerMenu />
      <Toaster 
        position="bottom-right"
        expand={false}
        richColors
        closeButton
      />
    </BrowserRouter>
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
