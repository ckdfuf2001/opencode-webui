import type { PermissionRule } from './types'
import { API_BASE_URL } from '@/config'

export async function listPermissionRules(repoId?: number): Promise<PermissionRule[]> {
  const query = repoId ? `?repoId=${repoId}` : ''
  const response = await fetch(`${API_BASE_URL}/api/permission-rules${query}`)

  if (!response.ok) {
    throw new Error('Failed to list permission rules')
  }

  return response.json()
}

export async function createPermissionRule(
  repoId: number,
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
