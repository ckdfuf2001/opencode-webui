/** 채팅 시각 표기: 오늘이면 시:분:초만, 오늘이 아니면 일자+시각. */
export function formatChatTime(created?: number): string {
  if (!created) return ''
  const d = new Date(created)
  const now = new Date()
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
  if (sameDay) return time
  return `${d.toLocaleDateString()} ${time}`
}
