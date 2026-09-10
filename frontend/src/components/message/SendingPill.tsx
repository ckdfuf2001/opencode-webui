import { memo, useEffect, useState } from 'react'
import { hasActiveSend } from '@/hooks/useOpenCode'

interface SendingPillProps {
  sessionID?: string
  busy: boolean
  lastIsUser: boolean
}

// 채팅 본문이 아니라 입력창 위 오버레이에 띄우는 전송 표시.
// 본문 optimistic 메시지는 비워두고, 여기가 유일한 sending 표시다.
// 큐 발송~첫 응답 사이 공백도 잡는다 (busy + 마지막이 user).
export const SendingPill = memo(function SendingPill({ sessionID, busy, lastIsUser }: SendingPillProps) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 500)
    return () => clearInterval(timer)
  }, [])

  if (!sessionID) return null
  const sending = hasActiveSend(sessionID) || (busy && lastIsUser)
  if (!sending) return null

  return (
    <div className="flex justify-center pointer-events-none">
      <span className="text-xs text-muted-foreground flex items-center gap-2 px-3 py-1.5 rounded-full border bg-card/90 shadow-sm">
        <span className="h-3 w-3 animate-spin rounded-full border border-muted-foreground border-t-transparent" />
        sending...
      </span>
    </div>
  )
})
