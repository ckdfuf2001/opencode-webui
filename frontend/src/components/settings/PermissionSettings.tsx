import { useState } from 'react'
import { Loader2, Plus, ShieldCheck, X } from 'lucide-react'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useGlobalPermissionRules, useCreatePermissionRule, useDeletePermissionRule } from '@/hooks/usePermissionRules'
import { showToast } from '@/lib/toast'

const PERMISSION_TYPES = ['bash', 'edit', 'webfetch', 'read', 'external_directory', '*']

function getPermissionLabel(permission: string): string {
  if (permission === '*') return 'Any'
  return permission.charAt(0).toUpperCase() + permission.slice(1)
}

export function PermissionSettings() {
  const { data: rules = [], isLoading } = useGlobalPermissionRules()
  const createRule = useCreatePermissionRule()
  const deleteRule = useDeletePermissionRule()
  const [permission, setPermission] = useState('bash')
  const [pattern, setPattern] = useState('')
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<number | null>(null)

  const handleAdd = async () => {
    if (!pattern.trim()) {
      showToast.error('Pattern is required.')
      return
    }
    setSaving(true)
    try {
      await createRule.mutateAsync({ repoId: null, permission, pattern: pattern.trim() })
      showToast.success('전역 자동승인 룰 추가됨 — 모든 레포 세션에 적용됩니다.')
      setPermission('bash')
      setPattern('')
    } catch (error) {
      showToast.error(error instanceof Error ? error.message : 'Failed to add permission rule.')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: number) => {
    setDeletingId(id)
    try {
      await deleteRule.mutateAsync({ id, repoId: null })
      showToast.success('전역 룰 제거됨.')
    } catch (error) {
      showToast.error(error instanceof Error ? error.message : 'Failed to remove permission rule.')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="bg-card border border-border rounded-lg p-6">
      <h2 className="text-lg font-semibold text-foreground mb-1 flex items-center gap-2">
        <ShieldCheck className="w-5 h-5 text-primary" />
        자동 승인 권한 (전역)
      </h2>
      <p className="text-sm text-muted-foreground mb-6">
        여기에 등록한 룰은 <b>모든 레포의 모든 세션</b>에서 권한 요청을 자동 승인합니다.
        적용 우선순위: 세션 룰 &gt; 레포 룰 &gt; 전역 룰. 레포별 룰은 각 레포 화면의 권한 패널에서 관리하세요.
        하위 경로까지 허용됩니다 (예: <code className="font-mono">/tmp/foo</code> → <code className="font-mono">/tmp/foo/bar</code>).
        <code className="font-mono">**</code> covers subdirectories (e.g. <code className="font-mono">C:/work/**</code>).
        전역 룰은 opencode 설정 파일에도 기록되어 재시작 후에도 ask가 다시 뜨지 않습니다 (적용은 다음 opencode 시작부터, 그 전에는 실시간 자동승인이 처리).
      </p>

      <div className="space-y-6">
        <div className="space-y-2">
          <Label>새 전역 룰 추가</Label>
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
              className="font-mono text-xs flex-1 bg-background border-border text-foreground placeholder:text-muted-foreground"
            />
            <Button size="icon" className="h-9 w-9 shrink-0" onClick={() => void handleAdd()} disabled={saving}>
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            glob 지원 (<code className="font-mono">*</code>, <code className="font-mono">**</code>). 종류에 Any를 고르면 모든 권한 종류에 적용됩니다.
          </p>
        </div>

        <div className="space-y-2">
          <Label>등록된 전역 룰 — {rules.length}개</Label>
          {isLoading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : rules.length === 0 ? (
            <p className="text-sm text-muted-foreground">등록된 전역 룰이 없습니다. 모든 권한 요청은 직접 승인해야 합니다.</p>
          ) : (
            <div className="space-y-2">
              {rules.map((rule) => (
                <div key={rule.id} className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background p-2.5">
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
                    onClick={() => void handleDelete(rule.id)}
                    disabled={deletingId === rule.id}
                    title="Remove rule"
                  >
                    {deletingId === rule.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
