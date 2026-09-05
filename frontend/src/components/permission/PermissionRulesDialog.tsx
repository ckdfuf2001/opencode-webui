import { useState, useEffect } from 'react'
import { Loader2, Plus, ShieldCheck, X, Volume2, Bell } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { usePermissionRules, useCreatePermissionRule, useDeletePermissionRule } from '@/hooks/usePermissionRules'
import { refreshAutoApproveData } from '@/hooks/useAutoApprovePermissions'
import { getSkillAutoUpdate, setSkillAutoUpdate } from '@/api/repos'
import type { PermissionRule } from '@/api/types'
import { showToast } from '@/lib/toast'
import { useSettings } from '@/hooks/useSettings'
import { getSessionOverride, setSessionOverride, getRepoOverride, setRepoOverride, getSessionPermissionRules, addSessionPermissionRule, deleteSessionPermissionRule, isPushSupported, ensurePushPermission, sendPushNotification, openNotificationSettings, getNotificationSettingsHelp, getNotificationSettingsUrl, getEffectiveSound, getEffectivePush, getEffectiveSkillAuto } from '@/lib/notifications'

interface PermissionRulesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  repoId?: number
  sessionId?: string
}

const PERMISSION_TYPES = ['bash', 'edit', 'webfetch', 'read', 'external_directory', '*']

function getPermissionLabel(permission: string): string {
  if (permission === '*') return 'Any'
  return permission.charAt(0).toUpperCase() + permission.slice(1)
}

export function PermissionRulesDialog({
  open,
  onOpenChange,
  repoId,
  sessionId,
}: PermissionRulesDialogProps) {
  const scope: 'global' | 'repo' | 'session' = sessionId ? 'session' : repoId ? 'repo' : 'global'
  const { data: rules = [], isLoading } = usePermissionRules(repoId)
  const rulesFiltered = scope === 'global' ? [] : rules
  const createRule = useCreatePermissionRule()
  const deleteRule = useDeletePermissionRule()
  const [permission, setPermission] = useState('bash')
  const [pattern, setPattern] = useState('')
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const [editingRepoId, setEditingRepoId] = useState<number | null>(null)
  const [editRepoPermission, setEditRepoPermission] = useState('bash')
  const [editRepoPattern, setEditRepoPattern] = useState('')
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editSessionPermission, setEditSessionPermission] = useState('bash')
  const [editSessionPattern, setEditSessionPattern] = useState('')
  const [ruleScope, setRuleScope] = useState<'repo' | 'session'>(scope === 'session' ? 'session' : 'repo')
  const queryClient = useQueryClient()
  const { data: skillAuto } = useQuery({
    queryKey: ['skill-auto-update', repoId ?? 'global'],
    queryFn: () => repoId ? getSkillAutoUpdate(repoId) : Promise.resolve({ enabled: false } as any),
    enabled: open && scope !== 'global' && !!repoId,
  })
  const skillMut = useMutation({
    mutationFn: (enabled: boolean) => {
      if (!repoId) throw new Error('repoId required')
      return setSkillAutoUpdate(repoId, enabled)
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['skill-auto-update', repoId], data)
      showToast.success(data.enabled ? 'Skill auto update enabled' : 'Skill auto update disabled')
    },
    onError: (e) => showToast.error(e instanceof Error ? e.message : 'Failed to update'),
  })

  // 알림/스킬 설정: 전역/레포/세션 계층
  const { preferences, updateSettings } = useSettings()
  const [sessionSoundOverride, setSessionSoundOverrideState] = useState<boolean | undefined>(undefined)
  const [sessionPushOverride, setSessionPushOverrideState] = useState<boolean | undefined>(undefined)
  const [repoSoundOverride, setRepoSoundOverrideState] = useState<boolean | undefined>(undefined)
  const [repoPushOverride, setRepoPushOverrideState] = useState<boolean | undefined>(undefined)
  const [sessionPermRules, setSessionPermRules] = useState<ReturnType<typeof getSessionPermissionRules>>([])
  useEffect(() => {
    if (!open) return
    // repo overrides
    if (repoId !== undefined) {
      const rov = getRepoOverride(repoId)
      setRepoSoundOverrideState(rov.soundEnabled)
      setRepoPushOverrideState(rov.pushEnabled)    } else {
      setRepoSoundOverrideState(undefined)
      setRepoPushOverrideState(undefined)    }
    // session overrides
    if (sessionId) {
      const ov = getSessionOverride(sessionId)
      setSessionSoundOverrideState(ov.soundEnabled)
      setSessionPushOverrideState(ov.pushEnabled)      setSessionPermRules(getSessionPermissionRules(sessionId))
    } else {
      setSessionSoundOverrideState(undefined)
      setSessionPushOverrideState(undefined)      setSessionPermRules([])
    }
    const handler = () => {
      if (repoId !== undefined) {
        const rov = getRepoOverride(repoId)
        setRepoSoundOverrideState(rov.soundEnabled)
        setRepoPushOverrideState(rov.pushEnabled)      }
      if (sessionId) {
        const ov = getSessionOverride(sessionId)
        setSessionSoundOverrideState(ov.soundEnabled)
        setSessionPushOverrideState(ov.pushEnabled)        setSessionPermRules(getSessionPermissionRules(sessionId))
      }
    }
    window.addEventListener('opencode:session-notify-changed', handler)
    window.addEventListener('opencode:repo-notify-changed', handler)
    window.addEventListener('opencode:session-perm-changed', handler)
    return () => {
      window.removeEventListener('opencode:session-notify-changed', handler)
      window.removeEventListener('opencode:repo-notify-changed', handler)
      window.removeEventListener('opencode:session-perm-changed', handler)
    }
  }, [open, repoId, sessionId])
  // effective values with hierarchy display
  const globalSoundOn = preferences?.completionSoundEnabled !== false
  const globalPushOn = preferences?.pushNotificationEnabled === true

  const resetForm = () => {
    setPermission('bash')
    setPattern('')
  }

  const handleAdd = async () => {
    if (!pattern.trim()) {
      showToast.error('Pattern is required.')
      return
    }
    setSaving(true)
    try {
      if (ruleScope === 'session' && sessionId) {
        addSessionPermissionRule(sessionId, { permission, pattern: pattern.trim() })
        setSessionPermRules(getSessionPermissionRules(sessionId))
        showToast.success('세션 전용 permission rule 추가됨 (이 세션에서만 동작)')
        refreshAutoApproveData()
      } else {
        if (!repoId) {
          showToast.error('전역 스코프에서는 세션 전용 룰만 추가할 수 있습니다. 레포를 선택해주세요.')
          return
        }
        await createRule.mutateAsync({ repoId, permission, pattern: pattern.trim() })
        refreshAutoApproveData()
        showToast.success(scope === 'session' ? '레포 permission rule 추가됨' : 'Permission rule added.')
      }
      resetForm()
    } catch (error) {
      showToast.error(error instanceof Error ? error.message : 'Failed to add permission rule.')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (rule: PermissionRule) => {
    setDeletingId(rule.id)
    try {
      await deleteRule.mutateAsync({ id: rule.id, repoId: repoId! })
      refreshAutoApproveData()
      showToast.success('Permission rule removed.')
    } catch (error) {
      showToast.error(error instanceof Error ? error.message : 'Failed to remove permission rule.')
    } finally {
      setDeletingId(null)
    }
  }
  const handleDeleteSessionRule = (id: string) => {
    if (!sessionId) return
    deleteSessionPermissionRule(sessionId, id)
    setSessionPermRules(getSessionPermissionRules(sessionId))
    refreshAutoApproveData()
    showToast.success('세션 룰 제거됨')
  }
  const handleSaveRepoEdit = async (id: number) => {
    if (!editRepoPattern.trim()) { setEditingRepoId(null); return }
    const orig = rulesFiltered.find(r=>r.id===id)
    if (!orig || (orig.pattern===editRepoPattern.trim() && orig.permission===editRepoPermission)) { setEditingRepoId(null); return }
    try {
      await deleteRule.mutateAsync({ id, repoId: repoId! })
      await createRule.mutateAsync({ repoId: repoId!, permission: editRepoPermission, pattern: editRepoPattern.trim() })
      refreshAutoApproveData()
      showToast.success('수정됨')
    } catch (e) { showToast.error(e instanceof Error?e.message:'수정 실패') }
    setEditingRepoId(null)
  }
  const handleSaveSessionEdit = (id: string) => {
    if (!editSessionPattern.trim() || !sessionId) { setEditingSessionId(null); return }
    const orig = sessionPermRules.find(r=>r.id===id)
    if (!orig || (orig.pattern===editSessionPattern.trim() && orig.permission===editSessionPermission)) { setEditingSessionId(null); return }
    deleteSessionPermissionRule(sessionId, id)
    addSessionPermissionRule(sessionId, { permission: editSessionPermission, pattern: editSessionPattern.trim() })
    setSessionPermRules(getSessionPermissionRules(sessionId))
    refreshAutoApproveData()
    showToast.success('수정됨')
    setEditingSessionId(null)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => {
      if (!next) resetForm()
      onOpenChange(next)
    }}>
      <DialogContent className="max-w-xl max-h-[90vh] p-0 gap-0 flex flex-col overflow-hidden">
        <div className="shrink-0 px-6 py-4 border-b bg-background space-y-2">
          <DialogHeader className="flex-row items-center gap-2 w-full p-0">
            <DialogTitle className="flex-1">
              <code className="text-xs bg-muted px-1 py-0.5 rounded break-all block mt-1">{getNotificationSettingsUrl()}</code>
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {globalPushOn && (
                    <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => void sendPushNotification('테스트 알림', { body: 'OS notification (requires pre-allow in browser settings)이 정상입니다.', tag: 'test-push' })}>테스트</Button>
                  )}
                  <Switch checked={globalPushOn} disabled={!isPushSupported()} onCheckedChange={async (v) => { if (v) { const perm = await ensurePushPermission(); if (perm !== 'granted') { openNotificationSettings(); showToast.error(getNotificationSettingsHelp() + ' — URL이 클립보드에 복사되었습니다. 새탭 주소창에 붙여넣어 이동하세요.'); return; } void sendPushNotification('알림 테스트', { body: 'OS notification (requires pre-allow in browser settings)이 활성화되었습니다.', tag: 'test-push' }); } updateSettings({ pushNotificationEnabled: v }); }} />
                </div>
              </div>
            </>
          )}
          {scope==='repo' && (
            <>
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label className="text-sm">완료 소리</Label>
                  <p className="text-xs text-muted-foreground">이 레포에서만</p>
                </div>
                <Switch checked={repoSoundOverride !== undefined ? repoSoundOverride : globalSoundOn} onCheckedChange={(v) => { const next = v === globalSoundOn ? undefined : v; setRepoOverride(repoId!, { soundEnabled: next }); setRepoSoundOverrideState(next); }} />
              </div>
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label className="text-sm flex items-center gap-1"><Bell className="w-3 h-3" /> OS notification (requires pre-allow in browser settings)</Label>
                  <p className="text-xs text-muted-foreground">{isPushSupported() ? 'OS notification (requires pre-allow in browser settings)' : '미지원'}</p>
                  {Notification.permission === 'denied' && (
                    <code className="text-xs bg-muted px-1 py-0.5 rounded break-all block mt-1">{getNotificationSettingsUrl()}</code>
                  )}
                </div>
                <Switch checked={repoPushOverride !== undefined ? repoPushOverride : globalPushOn} disabled={!isPushSupported()} onCheckedChange={async (v) => { if (v && isPushSupported() && Notification.permission !== 'granted') { const perm = await ensurePushPermission(); if (perm !== 'granted') { openNotificationSettings(); showToast.error(getNotificationSettingsHelp() + ' — URL이 클립보드에 복사되었습니다. 새탭 주소창에 붙여넣어 이동하세요.'); return; } } const next = v === globalPushOn ? undefined : v; setRepoOverride(repoId!, { pushEnabled: next }); setRepoPushOverrideState(next); }} />
              </div>
            </>
          )}
          {scope==='session' && (
            <>
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label className="text-sm">완료 소리</Label>
                  <p className="text-xs text-muted-foreground">이 세션에서만</p>
                </div>
                <Switch checked={sessionSoundOverride !== undefined ? sessionSoundOverride : (repoSoundOverride !== undefined ? repoSoundOverride : globalSoundOn)} onCheckedChange={(v) => { const parent = repoSoundOverride !== undefined ? repoSoundOverride : globalSoundOn; const next = v === parent ? undefined : v; setSessionOverride(sessionId!, { soundEnabled: next }); setSessionSoundOverrideState(next); }} />
              </div>
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label className="text-sm flex items-center gap-1"><Bell className="w-3 h-3" /> OS notification (requires pre-allow in browser settings)</Label>
                  <p className="text-xs text-muted-foreground">{isPushSupported() ? 'OS notification (requires pre-allow in browser settings)' : '미지원'}</p>
                  {Notification.permission === 'denied' && (
                    <code className="text-xs bg-muted px-1 py-0.5 rounded break-all block mt-1">{getNotificationSettingsUrl()}</code>
                  )}
                </div>
                <Switch checked={sessionPushOverride !== undefined ? sessionPushOverride : (repoPushOverride !== undefined ? repoPushOverride : globalPushOn)} disabled={!isPushSupported()} onCheckedChange={async (v) => { if (v && isPushSupported() && Notification.permission !== 'granted') { const perm = await ensurePushPermission(); if (perm !== 'granted') { openNotificationSettings(); showToast.error(getNotificationSettingsHelp() + ' — URL이 클립보드에 복사되었습니다. 새탭 주소창에 붙여넣어 이동하세요.'); return; } } const parent = repoPushOverride !== undefined ? repoPushOverride : globalPushOn; const next = v === parent ? undefined : v; setSessionOverride(sessionId!, { pushEnabled: next }); setSessionPushOverrideState(next); }} />
              </div>
            </>
            )}
        </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
