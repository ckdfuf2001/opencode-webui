import type { PermissionRule } from './types'
import { API_BASE_URL } from '@/config'

export async function listPermissionRules(repoId?: number, scope?: 'global'): Promise<PermissionRule[]> {
  const params = new URLSearchParams()
  if (scope === 'global') params.set('scope', 'global')
  else if (repoId) params.set('repoId', String(repoId))
  const query = params.size > 0 ? `?${params.toString()}` : ''
  const response = await fetch(`${API_BASE_URL}/api/permission-rules${query}`)

  if (!response.ok) {
    throw new Error('Failed to list permission rules')
  }

  return response.json()
}

export async function createPermissionRule(
  repoId: number | null,
  permission: string,
  pattern: string,
): Promise<PermissionRule> {
  const response = await fetch(`${API_BASE_URL}/api/permission-rules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ repoId, permission, pattern }),
  })

  if (!response.ok) {
    const error = await response.json().catch(() => null)
    throw new Error(error?.error || 'Failed to create permission rule')
  }

  return response.json()
}

export async function deletePermissionRule(id: number): Promise<void> {
  const response = await fetch(`${API_BASE_URL}/api/permission-rules/${id}`, {
    method: 'DELETE',
  })

  if (!response.ok) {
    const error = await response.json().catch(() => null)
    throw new Error(error?.error || 'Failed to delete permission rule')
  }
}
