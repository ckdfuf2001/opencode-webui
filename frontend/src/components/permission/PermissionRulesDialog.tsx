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
import { getSessionOverride, setSessionOverride, isPushSupported, ensurePushPermission } from '@/lib/notifications'

interface PermissionRulesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  repoId: number
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
  const { data: rules = [], isLoading } = usePermissionRules(repoId)
  const createRule = useCreatePermissionRule()
  const deleteRule = useDeletePermissionRule()
  const [permission, setPermission] = useState('bash')
  const [pattern, setPattern] = useState('')
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<number | null>(null)
  const queryClient = useQueryClient()
  const { data: skillAuto } = useQuery({
    queryKey: ['skill-auto-update', repoId],
    queryFn: () => getSkillAutoUpdate(repoId),
    enabled: open && !!repoId,
  })
  const skillMut = useMutation({
    mutationFn: (enabled: boolean) => setSkillAutoUpdate(repoId, enabled),
    onSuccess: (data) => {
      queryClient.setQueryData(['skill-auto-update', repoId], data)
      showToast.success(data.enabled ? 'Skill auto update enabled' : 'Skill auto update disabled')
    },
    onError: (e) => showToast.error(e instanceof Error ? e.message : 'Failed to update'),
  })

  // 알림 설정 (세션 상단 permission 패널에 글로벌/세션별 소리·PC 푸시)
  const { preferences, updateSettings } = useSettings()
  const [sessionSoundOverride, setSessionSoundOverrideState] = useState<boolean | undefined>(undefined)
  const [sessionPushOverride, setSessionPushOverrideState] = useState<boolean | undefined>(undefined)
  useEffect(() => {
    if (!open) return
    if (!sessionId) {
      setSessionSoundOverrideState(undefined)
      setSessionPushOverrideState(undefined)
      return
    }
    const ov = getSessionOverride(sessionId)
    setSessionSoundOverrideState(ov.soundEnabled)
    setSessionPushOverrideState(ov.pushEnabled)
    const handler = () => {
      const o = getSessionOverride(sessionId)
      setSessionSoundOverrideState(o.soundEnabled)
      setSessionPushOverrideState(o.pushEnabled)
    }
    window.addEventListener('opencode:session-notify-changed', handler)
    return () => window.removeEventListener('opencode:session-notify-changed', handler)
  }, [open, sessionId])
  const globalSoundOn = preferences?.completionSoundEnabled !== false
  const globalPushOn = preferences?.pushNotificationEnabled === true
  const effectiveSoundOn = sessionId ? (sessionSoundOverride === false ? false : sessionSoundOverride === true ? true : globalSoundOn) : globalSoundOn
  const effectivePushOn = sessionId ? (sessionPushOverride === false ? false : sessionPushOverride === true ? true : globalPushOn) : globalPushOn

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
      await createRule.mutateAsync({ repoId, permission, pattern: pattern.trim() })
      refreshAutoApproveData()
      showToast.success('Permission rule added.')
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
      await deleteRule.mutateAsync({ id: rule.id, repoId })
      refreshAutoApproveData()
      showToast.success('Permission rule removed.')
    } catch (error) {
      showToast.error(error instanceof Error ? error.message : 'Failed to remove permission rule.')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => {
      if (!next) resetForm()
      onOpenChange(next)
    }}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader className="flex-row items-center justify-start gap-2 sm:text-left">
          <DialogTitle>
            <span className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-primary" />
              Auto-Approved Permissions
            </span>
          </DialogTitle>
        </DialogHeader>

        <p className="text-xs text-muted-foreground">
          Requests matching these rules are approved automatically without showing a prompt.
          Rules are scoped to this project.
        </p>

        <div className="flex items-center justify-between rounded-lg border border-border bg-card p-3">
          <div className="space-y-0.5">
            <Label className="text-sm font-medium">Skill / Command auto update</Label>
            <p className="text-xs text-muted-foreground">When enabled, skill and command updates from memory are applied automatically without asking in chat.</p>
          </div>
          <Switch
            checked={skillAuto?.enabled ?? false}
            onCheckedChange={(v) => skillMut.mutate(v)}
            disabled={skillMut.isPending}
          />
        </div>

        <div className="rounded-lg border border-border bg-card p-3 space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Volume2 className="w-4 h-4" /> 알림 설정
          </div>
          <p className="text-xs text-muted-foreground">세션 상단의 Permission 패널에서 소리·PC 푸시를 세션별/글로벌로 제어합니다.</p>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm">완료 소리 (글로벌)</Label>
                <p className="text-xs text-muted-foreground">응답 완료 시 짧은 효과음</p>
              </div>
              <Switch
                checked={globalSoundOn}
                onCheckedChange={(v) => updateSettings({ completionSoundEnabled: v })}
              />
            </div>
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm">취소 시에도 소리</Label>
                <p className="text-xs text-muted-foreground">Abort/cancel 때도 완료음 재생</p>
              </div>
              <Switch
                checked={preferences?.completionSoundOnCancel !== false}
                onCheckedChange={(v) => updateSettings({ completionSoundOnCancel: v })}
              />
            </div>
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm flex items-center gap-1"><Bell className="w-3 h-3" /> PC 푸시 알림 (글로벌)</Label>
                <p className="text-xs text-muted-foreground">{isPushSupported() ? '브라우저 OS 알림으로 완료/권한 요청 알림' : '이 브라우저는 푸시 알림 미지원'}</p>
              </div>
              <Switch
                checked={globalPushOn}
                disabled={!isPushSupported()}
                onCheckedChange={async (v) => {
                  if (v) {
                    const perm = await ensurePushPermission()
                    if (perm !== 'granted') {
                      showToast.error('알림 권한이 거부되었습니다. 브라우저 설정에서 허용해주세요.')
                      return
                    }
                    try { new Notification('알림 테스트', { body: 'PC 푸시 알림이 활성화되었습니다.', tag: 'test-push' }) } catch {}
                  }
                  updateSettings({ pushNotificationEnabled: v })
                }}
              />
            </div>
            {sessionId && (
              <>
                <div className="border-t border-border pt-3 space-y-3">
                  <div className="text-xs font-medium text-muted-foreground">현재 세션 오버라이드</div>
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label className="text-sm">세션 소리</Label>
                      <p className="text-xs text-muted-foreground">이 세션만 {effectiveSoundOn ? 'ON' : 'OFF'} (글로벌 {globalSoundOn ? 'ON' : 'OFF'})</p>
                    </div>
                    <Switch
                      checked={effectiveSoundOn}
                      onCheckedChange={(v) => {
                        if (sessionId) {
                          setSessionOverride(sessionId, { soundEnabled: v })
                          setSessionSoundOverrideState(v)
                        }
                      }}
                    />
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <Label className="text-sm">세션 PC 푸시</Label>
                      <p className="text-xs text-muted-foreground">이 세션만 {effectivePushOn ? 'ON' : 'OFF'} (글로벌 {globalPushOn ? 'ON' : 'OFF'})</p>
                    </div>
                    <Switch
                      checked={effectivePushOn}
                      disabled={!isPushSupported()}
                      onCheckedChange={async (v) => {
                        if (v && isPushSupported() && Notification.permission !== 'granted') {
                          const perm = await ensurePushPermission()
                          if (perm !== 'granted') {
                            showToast.error('알림 권한이 거부되었습니다.')
                            return
                          }
                        }
                        if (sessionId) {
                          setSessionOverride(sessionId, { pushEnabled: v })
                          setSessionPushOverrideState(v)
                        }
                      }}
                    />
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="space-y-2 rounded-lg border border-border bg-card p-3">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            New rule
          </div>
          <div className="flex items-center gap-2">
            <Select value={permission} onValueChange={setPermission}>
              <SelectTrigger className="w-40 bg-background border-border">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PERMISSION_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {getPermissionLabel(type)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleAdd()
              }}
              placeholder="e.g. npm run build, **/*.ts, *"
              className="font-mono text-xs flex-1"
            />
            <Button size="icon" className="h-9 w-9 shrink-0" onClick={() => void handleAdd()} disabled={saving}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Supports glob patterns: <code className="font-mono">*</code> (within a path segment) and <code className="font-mono">**</code> (across segments). Choose "Any" to match every permission type.
          </p>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : rules.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-10">
            No rules yet. Add one above or click "Allow Always" on a permission request.
          </p>
        ) : (
          <div className="space-y-2 max-h-[40vh] overflow-y-auto pr-1">
            {rules.map((rule) => (
              <div key={rule.id} className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card p-2.5">
                <div className="flex items-center gap-2 min-w-0">
                  <Badge variant="outline" className="text-[10px] shrink-0">
                    {getPermissionLabel(rule.permission)}
                  </Badge>
                  <span className="text-xs font-mono truncate">{rule.pattern}</span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0"
                  onClick={() => void handleDelete(rule)}
                  disabled={deletingId === rule.id}
                  title="Remove rule"
                >
                  {deletingId === rule.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
                </Button>
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
