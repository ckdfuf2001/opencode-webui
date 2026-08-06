import { useState } from 'react'
import { Loader2, Plus, ShieldCheck, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { usePermissionRules, useCreatePermissionRule, useDeletePermissionRule } from '@/hooks/usePermissionRules'
import { refreshAutoApproveData } from '@/hooks/useAutoApprovePermissions'
import type { PermissionRule } from '@/api/types'
import { showToast } from '@/lib/toast'

interface PermissionRulesDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  repoId: number
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
}: PermissionRulesDialogProps) {
  const { data: rules = [], isLoading } = usePermissionRules(repoId)
  const createRule = useCreatePermissionRule()
  const deleteRule = useDeletePermissionRule()
  const [permission, setPermission] = useState('bash')
  const [pattern, setPattern] = useState('')
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<number | null>(null)

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
