export interface PermissionRule {
  id: number
  /** null이면 전역 룰 — 모든 레포 세션에 적용 */
  repoId: number | null
  permission: string
  pattern: string
  createdAt: number
}

export interface CreatePermissionRuleInput {
  /** null/undefined면 전역 룰 */
  repoId: number | null
  permission: string
  pattern: string
}
