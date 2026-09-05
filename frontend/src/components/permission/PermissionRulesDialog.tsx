import { useState, useEffect } from 'react'
import { Loader2, Plus, ShieldCheck, X, Volume2, Bell, ChevronDown } from 'lucide-react'
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
import { getSessionOverride, setSessionOverride, getRepoOverride, setRepoOverride, getSessionPermissionRules, addSessionPermissionRule, deleteSessionPermissionRule, isPushSupported, ensurePushPermission, sendPushNotification, openNotificationSettings, getNotificationSettingsHelp, getEffectiveSound, getEffectivePush, getEffectiveSkillAuto } from '@/lib/notifications'

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
  const [ruleScope, setRuleScope] = useState<'repo' | 'session'>(scope === 'session' ? 'session' : 'repo')
  const [notifyExpanded, setNotifyExpanded] = useState(false)
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
  const [sessionSkillOverride, setSessionSkillOverrideState] = useState<boolean | undefined>(undefined)
  const [repoSoundOverride, setRepoSoundOverrideState] = useState<boolean | undefined>(undefined)
  const [repoPushOverride, setRepoPushOverrideState] = useState<boolean | undefined>(undefined)
  const [repoSkillOverride, setRepoSkillOverrideState] = useState<boolean | undefined>(undefined)
  const [sessionPermRules, setSessionPermRules] = useState<ReturnType<typeof getSessionPermissionRules>>([])
  useEffect(() => {
    if (!open) return
    // repo overrides
    if (repoId !== undefined) {
      const rov = getRepoOverride(repoId)
      setRepoSoundOverrideState(rov.soundEnabled)
      setRepoPushOverrideState(rov.pushEnabled)
      setRepoSkillOverrideState(rov.skillAutoEnabled)
    } else {
      setRepoSoundOverrideState(undefined)
      setRepoPushOverrideState(undefined)
      setRepoSkillOverrideState(undefined)
    }
    // session overrides
    if (sessionId) {
      const ov = getSessionOverride(sessionId)
      setSessionSoundOverrideState(ov.soundEnabled)
      setSessionPushOverrideState(ov.pushEnabled)
      setSessionSkillOverrideState(ov.skillAutoEnabled)
      setSessionPermRules(getSessionPermissionRules(sessionId))
    } else {
      setSessionSoundOverrideState(undefined)
      setSessionPushOverrideState(undefined)
      setSessionSkillOverrideState(undefined)
      setSessionPermRules([])
    }
    const handler = () => {
      if (repoId !== undefined) {
        const rov = getRepoOverride(repoId)
        setRepoSoundOverrideState(rov.soundEnabled)
        setRepoPushOverrideState(rov.pushEnabled)
        setRepoSkillOverrideState(rov.skillAutoEnabled)
      }
      if (sessionId) {
        const ov = getSessionOverride(sessionId)
        setSessionSoundOverrideState(ov.soundEnabled)
        setSessionPushOverrideState(ov.pushEnabled)
        setSessionSkillOverrideState(ov.skillAutoEnabled)
        setSessionPermRules(getSessionPermissionRules(sessionId))
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
  const soundEff = getEffectiveSound(repoId, sessionId, preferences ?? {})
  const pushEff = getEffectivePush(repoId, sessionId, preferences ?? {})
  const skillEff = getEffectiveSkillAuto(repoId, sessionId, skillAuto?.enabled)
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

  return (
    <Dialog open={open} onOpenChange={(next) => {
      if (!next) resetForm()
      onOpenChange(next)
    }}>
      <DialogContent className="max-w-xl max-h-[90vh] p-0 gap-0 flex flex-col overflow-hidden">
        <div className="shrink-0 px-6 py-4 border-b bg-background space-y-2">
          <DialogHeader className="flex-row items-center gap-2 w-full p-0">
            <DialogTitle className="flex-1">
              <span className="flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-primary" />
                Auto-Approved Permissions
              </span>
            </DialogTitle>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <Badge variant={scope==='global'?'default':scope==='repo'?'secondary':'outline'} className="text-xs">
              {scope==='global' ? '전역' : scope==='repo' ? `레포 #${repoId}` : `세션`}
            </Badge>
            <span className="text-xs text-muted-foreground">
              {scope==='global' ? '전역' : scope==='repo' ? '레포 스콥' : '세션 스콥'}
            </span>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-6 pt-4 space-y-4">

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

        <div className="space-y-2 rounded-lg border border-border bg-card p-3">
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              New rule {scope==='global' ? '(전역에선 레포 선택 후 추가)' : scope==='repo' ? '(레포 스콥)' : '(레포/세션 선택)'}
            </div>
            {scope==='session' && (
              <Select value={ruleScope} onValueChange={(v) => setRuleScope(v as 'repo'|'session')}>
                <SelectTrigger className="w-28 h-7 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="repo">레포</SelectItem>
                  <SelectItem value="session">세션</SelectItem>
                </SelectContent>
              </Select>
            )}
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
            <Button size="icon" className="h-9 w-9 shrink-0" onClick={() => void handleAdd()} disabled={saving || scope==='global'}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {scope==='session' && ruleScope==='session' ? '세션 룰: 이 세션에서만 자동 승인 (로컬스토리지).' : scope==='session' && ruleScope==='repo' ? '레포 룰: 이 레포의 모든 세션에서 자동 승인 (DB).' : ''} 
            Supports glob patterns: <code className="font-mono">*</code> and <code className="font-mono">**</code>. Choose "Any" to match every permission type.
          </p>
        </div>

        {/* 레포 룰 */}
        {scope !== 'global' && (
          <>
            <div className="text-xs font-medium text-muted-foreground">레포 룰 (DB) — {rulesFiltered.length}개</div>
            {isLoading ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
              </div>
            ) : rulesFiltered.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">
                레포 룰 없음. 위에서 추가하거나 permission 요청에서 "Allow Always" 클릭.
              </p>
            ) : (
              <div className="space-y-2 max-h-[20vh] overflow-y-auto pr-1">
                {rulesFiltered.map((rule) => (
                  <div key={rule.id} className="flex items-center justify-between gap-2 rounded-lg border border-border bg-card p-2.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <Badge variant="outline" className="text-[10px] shrink-0">
                        {getPermissionLabel(rule.permission)}
                      </Badge>
                      <span className="text-xs font-mono truncate">{rule.pattern}</span>
                      <Badge variant="secondary" className="text-[10px]">레포</Badge>
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
          </>
        )}

        {/* 세션 룰 */}
        {scope === 'session' && (
          <>
            <div className="text-xs font-medium text-muted-foreground mt-2">세션 룰 (로컬) — {sessionPermRules.length}개 {sessionPermRules.length>0 && <span className="font-normal">· 이 세션에서만 동작, 레포보다 우선</span>}</div>
            {sessionPermRules.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">세션 전용 룰 없음.</p>
            ) : (
              <div className="space-y-2 max-h-[20vh] overflow-y-auto pr-1">
                {sessionPermRules.map((rule) => (
                  <div key={rule.id} className="flex items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <Badge variant="outline" className="text-[10px] shrink-0">
                        {getPermissionLabel(rule.permission)}
                      </Badge>
                      <span className="text-xs font-mono truncate">{rule.pattern}</span>
                      <Badge className="text-[10px] bg-amber-500">세션</Badge>
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 text-muted-foreground hover:text-destructive shrink-0"
                      onClick={() => handleDeleteSessionRule(rule.id)}
                      title="Remove session rule"
                    >
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {scope === 'global' && (
          <p className="text-xs text-muted-foreground text-center py-2">전역에서는 알림/스킬 전역값만 설정합니다. Permission 룰은 레포 또는 세션 패널에서 추가하세요.</p>
        )}
        {/* 알림·스킬 설정 - 맨 아래, 클릭 시 상세 ON/OFF */}
        <div className="rounded-lg border border-border bg-card p-3">
          <button type="button" onClick={()=>setNotifyExpanded(!notifyExpanded)} className="w-full flex items-center justify-between text-left">
            <span className="flex items-center gap-2 text-sm font-medium"><Volume2 className="w-4 h-4" /> 알림·스킬 설정 <Badge variant="outline" className="text-xs ml-1">${scope==='global'?'전역':scope==='repo'?'레포':'세션'}</Badge></span>
            <span className="flex items-center gap-2">
              <Badge variant={soundEff.effective?'default':'outline'} className="text-xs">소리 {soundEff.effective?'ON':'OFF'}</Badge>
              <Badge variant={pushEff.effective?'default':'outline'} className="text-xs">푸시 {pushEff.effective?'ON':'OFF'}</Badge>
              <Badge variant={skillEff.effective?'default':'outline'} className="text-xs">스킬 {skillEff.effective?'ON':'OFF'}</Badge>
              <ChevronDown className={`w-4 h-4 transition-transform ${notifyExpanded?'rotate-180':''}`} />
            </span>
          </button>
          {notifyExpanded && <div className="mt-3 space-y-3">
            <div className="space-y-3">
            {/* 글로벌 */}
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm">완료 소리 (글로벌)</Label>
                <p className="text-xs text-muted-foreground">응답 완료 시 효과음 · 전역 기본값</p>
              </div>
              <Switch
                checked={globalSoundOn}
                onCheckedChange={(v) => updateSettings({ completionSoundEnabled: v })}
              />
            </div>
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-sm">취소 시에도 소리 (글로벌)</Label>
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
                <p className="text-xs text-muted-foreground">{isPushSupported() ? 'OS 알림으로 완료/권한 요청' : '미지원 브라우저'}</p>
                {Notification.permission === 'denied' && (
                  <p className="text-xs text-destructive flex items-center gap-2">
                    브라우저에서 차단됨
                    <Button variant="outline" size="sm" className="h-6 text-xs px-2" onClick={() => { const ok=openNotificationSettings(); if(!ok) showToast.info(getNotificationSettingsHelp()); }}>설정 열기</Button>
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                {globalPushOn && (
                  <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => void sendPushNotification('테스트 알림', { body: 'PC 푸시 알림이 정상입니다.', tag: 'test-push' })}>테스트</Button>
                )}
                <Switch
                  checked={globalPushOn}
                  disabled={!isPushSupported()}
                  onCheckedChange={async (v) => {
                    if (v) {
                      const perm = await ensurePushPermission()
                      if (perm !== 'granted') {
                        showToast.error('알림 권한이 거부되었습니다. 주소창 왼쪽 자물쇠 → 사이트 설정 → 알림 허용으로 수동 변경해야 합니다. (브라우저 보안상 코드로 강제 변경 불가)')
                        return
                      }
                      void sendPushNotification('알림 테스트', { body: 'PC 푸시 알림이 활성화되었습니다.', tag: 'test-push' })
                    }
                    updateSettings({ pushNotificationEnabled: v })
                  }}
                />
              </div>
            </div>
            {/* 현재 위치 기준 효과 요약 - 상세 설정展开 시에만 보임 */}
            <div className="rounded border border-dashed p-2 grid grid-cols-5 gap-1 text-xs">
              <div className="font-medium"></div><div className="text-center text-muted-foreground">전역</div><div className="text-center text-muted-foreground">레포</div><div className="text-center text-muted-foreground">세션</div><div className="text-center font-bold">적용</div>
              <div>소리</div><div className="text-center"><Badge variant={globalSoundOn?'default':'outline'} className="text-xs px-1">{globalSoundOn?'ON':'OFF'}</Badge></div><div className="text-center"><Badge variant={repoSoundOverride===undefined?'outline':repoSoundOverride?'default':'destructive'} className="text-xs px-1">{repoSoundOverride===undefined?'—':repoSoundOverride?'ON':'OFF'}</Badge></div><div className="text-center"><Badge variant={sessionSoundOverride===undefined?'outline':sessionSoundOverride?'default':'destructive'} className="text-xs px-1">{sessionSoundOverride===undefined?'—':sessionSoundOverride?'ON':'OFF'}</Badge></div><div className="text-center"><Badge variant={soundEff.effective?'default':'destructive'} className="text-xs px-1">{soundEff.effective?'ON':'OFF'}</Badge></div>
              <div>푸시</div><div className="text-center"><Badge variant={globalPushOn?'default':'outline'} className="text-xs px-1">{globalPushOn?'ON':'OFF'}</Badge></div><div className="text-center"><Badge variant={repoPushOverride===undefined?'outline':repoPushOverride?'default':'destructive'} className="text-xs px-1">{repoPushOverride===undefined?'—':repoPushOverride?'ON':'OFF'}</Badge></div><div className="text-center"><Badge variant={sessionPushOverride===undefined?'outline':sessionPushOverride?'default':'destructive'} className="text-xs px-1">{sessionPushOverride===undefined?'—':sessionPushOverride?'ON':'OFF'}</Badge></div><div className="text-center"><Badge variant={pushEff.effective?'default':'destructive'} className="text-xs px-1">{pushEff.effective?'ON':'OFF'}</Badge></div>
            </div>

            {/* 레포 오버라이드 (레포/세션 스콥에서 편집 가능) */}
            {repoId !== undefined && (
              <div className="border-t border-border pt-3 space-y-3">
                <div className="text-xs font-medium text-muted-foreground">레포 오버라이드 (레포 #{repoId})</div>
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label className="text-sm">레포 소리</Label>
                    <p className="text-xs text-muted-foreground">전역 {globalSoundOn?'ON':'OFF'} → 레포 {repoSoundOverride===undefined?'상속':repoSoundOverride?'ON':'OFF'} → 적용 {soundEff.effective?'ON':'OFF'}</p>
                  </div>
                  <Switch
                    checked={repoSoundOverride !== undefined ? repoSoundOverride : globalSoundOn}
                    onCheckedChange={(v) => {
                      const next = v === globalSoundOn ? undefined : v
                      setRepoOverride(repoId, { soundEnabled: next })
                      setRepoSoundOverrideState(next)
                    }}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label className="text-sm">레포 PC 푸시</Label>
                    <p className="text-xs text-muted-foreground">전역 {globalPushOn?'ON':'OFF'} → 레포 {repoPushOverride===undefined?'상속':repoPushOverride?'ON':'OFF'}</p>
                  </div>
                  <Switch
                    checked={repoPushOverride !== undefined ? repoPushOverride : globalPushOn}
                    disabled={!isPushSupported()}
                    onCheckedChange={async (v) => {
                      if (v && isPushSupported() && Notification.permission !== 'granted') {
                        const perm = await ensurePushPermission()
                        if (perm !== 'granted') { showToast.error('알림 권한 거부'); return }
                      }
                      const next = v === globalPushOn ? undefined : v
                      setRepoOverride(repoId, { pushEnabled: next })
                      setRepoPushOverrideState(next)
                    }}
                  />
                </div>
</div>
            )}

            {/* 세션 오버라이드 */}
            {sessionId && (
              <div className="border-t border-border pt-3 space-y-3">
                <div className="text-xs font-medium text-muted-foreground">세션 오버라이드 ({sessionId.slice(0,8)})</div>
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label className="text-sm">세션 소리</Label>
                    <p className="text-xs text-muted-foreground">레포 {repoSoundOverride===undefined? (globalSoundOn?'ON':'OFF') : repoSoundOverride?'ON':'OFF'} → 세션 {sessionSoundOverride===undefined?'상속':sessionSoundOverride?'ON':'OFF'} → 적용 {soundEff.effective?'ON':'OFF'}</p>
                  </div>
                  <Switch
                    checked={sessionSoundOverride !== undefined ? sessionSoundOverride : (repoSoundOverride !== undefined ? repoSoundOverride : globalSoundOn)}
                    onCheckedChange={(v) => {
                      const parent = repoSoundOverride !== undefined ? repoSoundOverride : globalSoundOn
                      const next = v === parent ? undefined : v
                      setSessionOverride(sessionId, { soundEnabled: next })
                      setSessionSoundOverrideState(next)
                    }}
                  />
                </div>
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label className="text-sm">세션 PC 푸시</Label>
                    <p className="text-xs text-muted-foreground">레포 {repoPushOverride===undefined? (globalPushOn?'ON':'OFF') : repoPushOverride?'ON':'OFF'} → 세션 {sessionPushOverride===undefined?'상속':sessionPushOverride?'ON':'OFF'}</p>
                  </div>
                  <Switch
                    checked={sessionPushOverride !== undefined ? sessionPushOverride : (repoPushOverride !== undefined ? repoPushOverride : globalPushOn)}
                    disabled={!isPushSupported()}
                    onCheckedChange={async (v) => {
                      if (v && isPushSupported() && Notification.permission !== 'granted') {
                        const perm = await ensurePushPermission()
                        if (perm !== 'granted') { showToast.error('알림 권한 거부'); return }
                      }
                      const parent = repoPushOverride !== undefined ? repoPushOverride : globalPushOn
                      const next = v === parent ? undefined : v
                      setSessionOverride(sessionId, { pushEnabled: next })
                      setSessionPushOverrideState(next)
                    }}
                  />
                </div>
</div>
            )}
          </div>
          </div>}
        </div>

              </div>
      </DialogContent>
    </Dialog>
  )
}
