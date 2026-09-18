import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { useCreatePermissionRule } from '@/hooks/usePermissionRules'
import type { Permission, PermissionResponse } from '@/api/types'
import { cn } from '@/lib/utils'

interface PermissionRequestCardProps {
  permission: Permission
  pendingCount: number
  viewedSessionID?: string
  sessionTitles?: Record<string, string>
  repoId?: number
  onRespond: (permissionID: string, sessionID: string, response: PermissionResponse) => Promise<void>
  onDismiss: (permissionID: string) => void
}

function getRulePatterns(permission: Permission): string[] {
  const patterns = permission.patterns ?? permission.pattern
  const normalized = Array.isArray(patterns) ? patterns : patterns ? [patterns] : []
  if (normalized.length > 0) return normalized
  const metadata = (permission.metadata ?? {}) as Record<string, unknown>
  const asString = (v: unknown): string[] => (typeof v === 'string' && v ? [v] : [])
  return [
    ...asString(metadata.command),
    ...asString(metadata.path),
    ...asString(metadata.url),
    ...asString(metadata.filepath),
    ...asString(metadata.parentDir),
    ...asString(metadata.directory),
  ]
}

function getPermissionTypeLabel(type: string): string {
  switch (type) {
    case 'bash':
      return 'Run Command'
    case 'edit':
      return 'Edit File'
    case 'webfetch':
      return 'Fetch URL'
    case 'external_directory':
      return 'Access External Directory'
    case 'read':
      return 'Read File'
    default:
      return type.charAt(0).toUpperCase() + type.slice(1)
  }
}

function getPermissionDescription(permission: Permission): string {
  const patterns = permission.patterns ?? permission.pattern
  const normalized = Array.isArray(patterns) ? patterns : patterns ? [patterns] : []

  if (normalized.length > 0) {
    return normalized.join('\n')
  }

  if (permission.metadata?.command) {
    return String(permission.metadata.command)
  }

  if (permission.metadata?.path) {
    return String(permission.metadata.path)
  }

  if (permission.metadata?.url) {
    return String(permission.metadata.url)
  }

  return ''
}

export function PermissionRequestCard({
  permission,
  pendingCount,
  viewedSessionID,
  sessionTitles,
  repoId,
  onRespond,
  onDismiss,
}: PermissionRequestCardProps) {
  const [isLoading, setIsLoading] = useState(false)
  const [loadingAction, setLoadingAction] = useState<PermissionResponse | null>(null)
  const createRule = useCreatePermissionRule()

  const handleResponse = async (response: PermissionResponse) => {
    setIsLoading(true)
    setLoadingAction(response)
    onDismiss(permission.id)
    try {
      await onRespond(permission.id, permission.sessionID, response)
      if (response === 'always' && repoId) {
        // ask 패턴이 여러 개면 전부 룰로 저장한다 (외부 폴더 2곳 동시 요청 등).
        // 서버가 중복은 기존 행으로 흡수하므로 그대로 보낸다.
        const type = permission.permission ?? permission.type
        for (const pattern of getRulePatterns(permission)) {
          try {
            await createRule.mutateAsync({ repoId, permission: type, pattern })
          } catch (error) {
            console.error('Failed to save permission rule:', error)
          }
        }
      }
    } catch (error) {
      console.error('Failed to respond to permission:', error)
    } finally {
      setIsLoading(false)
      setLoadingAction(null)
    }
  }

  const typeLabel = getPermissionTypeLabel(permission.permission ?? permission.type)
  const description = getPermissionDescription(permission)
  const alwaysPatterns = permission.always ?? []
  const isSubagentRequest = !!viewedSessionID && permission.sessionID !== viewedSessionID
  const sourceSessionTitle = sessionTitles?.[permission.sessionID]

  return (
    <div className="w-full rounded-lg p-1.5 bg-card/60 border border-primary/30 animate-pulse-subtle">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-xs font-medium text-primary">Permission Request</span>
        {pendingCount > 1 && (
          <span className="text-xs font-normal text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
            +{pendingCount - 1} more
          </span>
        )}
      </div>

      <div className="space-y-3 border rounded-md p-4">
        <div className="space-y-1">
          <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            {typeLabel}
          </div>
          <div className="text-sm">{permission.title || `Allow ${typeLabel.toLowerCase()}?`}</div>
        </div>

        {description && (
          <div className="bg-muted/50 border rounded-md p-3 max-h-32 overflow-y-auto">
            <pre className="text-sm font-mono whitespace-pre-wrap break-all">
              {description}
            </pre>
          </div>
        )}

        {alwaysPatterns.length > 0 && (
          <div className="text-xs text-muted-foreground">
            Allow Always approves:
            <pre className="mt-1 font-mono whitespace-pre-wrap break-all text-muted-foreground">
              {alwaysPatterns.join('\n')}
            </pre>
          </div>
        )}

        <div className="text-xs text-muted-foreground">
          {isSubagentRequest ? (
            <>
              From subagent: <span className="font-mono">{sourceSessionTitle || `${permission.sessionID.slice(0, 12)}...`}</span>
            </>
          ) : (
            <>
              Session: <span className="font-mono">{permission.sessionID.slice(0, 12)}...</span>
            </>
          )}
        </div>
      </div>

      <div className="mt-3 flex justify-end gap-2">
        <Button
          variant="outline"
          onClick={() => handleResponse('reject')}
          disabled={isLoading}
          className={cn(loadingAction === 'reject' && "opacity-70")}
        >
          {loadingAction === 'reject' ? 'Denying...' : 'Deny'}
        </Button>
        <Button
          variant="secondary"
          onClick={() => handleResponse('once')}
          disabled={isLoading}
          className={cn(loadingAction === 'once' && "opacity-70")}
        >
          {loadingAction === 'once' ? 'Allowing...' : 'Allow Once'}
        </Button>
        <Button
          variant="default"
          onClick={() => handleResponse('always')}
          disabled={isLoading}
          className={cn(loadingAction === 'always' && "opacity-70")}
        >
          {loadingAction === 'always' ? 'Allowing...' : 'Allow Always'}
        </Button>
      </div>
    </div>
  )
}
