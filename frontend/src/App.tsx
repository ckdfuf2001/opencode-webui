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
import { isPushSupported, ensurePushPermission, sendPushNotification, openNotificationSettings, getNotificationSettingsHelp } from './lib/notifications'
import { useState, useEffect } from 'react'
import { Button } from './components/ui/button'
import { Bell } from 'lucide-react'

startAutoApprover()

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 30,
      gcTime: 1000 * 60 * 10,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      refetchOnMount: false,
    },
  },
})

function PushPrompt() {
  const { updateSettings } = useSettings()
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!isPushSupported()) return
    // 처음 접속(default)일 때만 배너 표시 — 이전에 허용/거부한 적 없으면
    if (Notification.permission !== 'default') return
    if (localStorage.getItem('opencode-push-prompt-dismissed')) return
    // 즉시 표시 (유튜브처럼 첫 방문 시 배너)
    setVisible(true)
  }, [])
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
            const ok = openNotificationSettings()
            if (!ok) {
              const { showToast } = await import('./lib/toast')
              showToast.info(getNotificationSettingsHelp())
            }
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

  return (
    <BrowserRouter>
      <PushPrompt />
      <Routes>
        <Route path="/" element={<Repos />} />
        <Route path="/search" element={<Search />} />
        <Route path="/repos/:id" element={<RepoDetail />} />
        <Route path="/repos/:id/sessions/:sessionId" element={<SessionDetail />} />
        <Route path="/session/:sessionId" element={<SessionDetail />} />
      </Routes>
      <SettingsDialog open={isOpen} onOpenChange={close} />
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
