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
  const { preferences, updateSettings } = useSettings()
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    if (!isPushSupported()) return
    if (Notification.permission !== 'default') return
    if (localStorage.getItem('opencode-push-prompt-dismissed')) return
    // 전역 푸시가 꺼져 있어도 처음 한 번은 물어봄 (유튜브처럼)
    const t = setTimeout(() => setVisible(true), 1200)
    return () => clearTimeout(t)
  }, [preferences])
  if (!visible) return null
  return (
    <div className="sticky top-0 z-40 bg-amber-500/10 border-b border-amber-500/30 px-4 py-2 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 text-sm">
        <Bell className="w-4 h-4 text-amber-600" />
        <span>PC 알림을 허용하면 응답 완료·권한 요청을 브라우저/OS 알림으로 받을 수 있습니다.</span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => { localStorage.setItem('opencode-push-prompt-dismissed','1'); setVisible(false); }}>나중에</Button>
        <Button size="sm" className="h-7 text-xs" onClick={async () => {
          const perm = await ensurePushPermission()
          if (perm === 'granted') {
            updateSettings({ pushNotificationEnabled: true })
            void sendPushNotification('알림 허용됨', { body: '이제 PC 알림을 받을 수 있습니다.', tag: 'push-enabled' })
            setVisible(false)
          } else if (perm === 'denied') {
            localStorage.setItem('opencode-push-prompt-dismissed','1')
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
