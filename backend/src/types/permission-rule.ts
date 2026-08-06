export interface PermissionRule {
  id: number
  repoId: number
  permission: string
  pattern: string
  createdAt: number
}

export interface CreatePermissionRuleInput {
  repoId: number
  permission: string
  pattern: string
}
