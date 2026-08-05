import { useNavigate, useLocation } from 'react-router-dom'
import { usePermissionRequests } from '@/hooks/usePermissionRequests'
import { useOpenCodeClient } from '@/hooks/useOpenCode'
import { PermissionRequestCard } from '@/components/session/PermissionRequestCard'
import { OPENCODE_API_ENDPOINT } from '@/config'
import type { PermissionResponse } from '@/api/types'

const SESSION_DETAIL_PATHS = [/^\/session\/[^/]+$/, /^\/repos\/[^/]+\/sessions\/[^/]+$/]

export function GlobalPermissionToast() {
  const navigate = useNavigate()
  const location = useLocation()
  const { currentPermission, pendingCount, dismissPermission } = usePermissionRequests()
  const client = useOpenCodeClient(OPENCODE_API_ENDPOINT, currentPermission?.directory)

  const onSessionDetail = SESSION_DETAIL_PATHS.some((re) => re.test(location.pathname))

  if (!currentPermission || onSessionDetail) return null

  const handleRespond = async (permissionID: string, sessionID: string, response: PermissionResponse) => {
    if (!client) return
    if (currentPermission.v2) {
      await client.respondToPermissionV2(permissionID, response)
    } else {
      await client.respondToPermission(sessionID, permissionID, response)
    }
  }

  const openSession = () => {
    navigate(`/session/${currentPermission.sessionID}`)
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 w-[360px] max-w-[calc(100vw-2rem)]">
      <PermissionRequestCard
        permission={currentPermission}
        pendingCount={pendingCount}
        onRespond={handleRespond}
        onDismiss={dismissPermission}
      />
      <button
        onClick={openSession}
        className="mt-1 w-full text-[11px] text-muted-foreground hover:text-primary transition-colors"
        title="Open the session this request belongs to"
      >
        Open this session
      </button>
    </div>
  )
}
