export type ApprovalType = 'general' | 'auto' | 'notify'

export interface Agent {
  prompt?: string
  description?: string
  mode?: 'subagent' | 'primary' | 'all'
  temperature?: number
  topP?: number
  approvalType?: ApprovalType
  model?: {
    modelID: string
    providerID: string
  }
  tools?: Record<string, boolean>
  permission?: {
    edit?: 'ask' | 'allow' | 'deny'
    bash?: 'ask' | 'allow' | 'deny' | Record<string, 'ask' | 'allow' | 'deny'>
    webfetch?: 'ask' | 'allow' | 'deny'
  }
  disable?: boolean
  [key: string]: unknown
}

export const APPROVAL_TYPE_LABELS: Record<ApprovalType, string> = {
  general: '일반 대화',
  auto: '슈퍼 배치',
  notify: '알림',
}

export const NOTIFY_MARKER = '## 업무 알림 모드'
export const NOTIFY_PROMPT_BLOCK = `
${NOTIFY_MARKER}
- 모든 도구는 자동 승인되어 실행된다.
- 각 단계 실행 후 진행 상황·결과·다음 계획을 반드시 사용자에게 보고한다.
- 위험하거나 모호한 판단이 필요하면 잠시 멈추고 요약해 알린 뒤 계속한다.`

export function hasNotifyPrompt(prompt?: string): boolean {
  return !!prompt && prompt.includes(NOTIFY_MARKER)
}

export function inferApprovalType(agent?: Agent): ApprovalType {
  const t = agent?.approvalType
  if (t === 'general' || t === 'auto' || t === 'notify') return t
  if (hasNotifyPrompt(agent?.prompt)) return 'notify'
  const p = agent?.permission
  const vals: ('ask' | 'allow' | 'deny')[] = []
  if (p?.edit) vals.push(p.edit)
  if (p?.webfetch) vals.push(p.webfetch)
  if (typeof p?.bash === 'string') vals.push(p.bash)
  if (vals.length > 0 && vals.every((v) => v === 'allow')) return 'auto'
  return 'general'
}