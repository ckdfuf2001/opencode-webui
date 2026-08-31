import { useContextUsage } from '@/hooks/useContextUsage'
import { useState } from 'react'

interface ContextUsageIndicatorProps {
  opcodeUrl: string | null
  sessionID: string | undefined
  directory?: string
}

export function ContextUsageIndicator({ opcodeUrl, sessionID, directory }: ContextUsageIndicatorProps) {
  const { totalTokens, contextLimit, usagePercentage, isLoading } = useContextUsage(opcodeUrl, sessionID, directory)
  const [isHovered, setIsHovered] = useState(false)

  const getUsageColor = (percentage: number) => {
    if (percentage < 50) return 'text-green-500'
    if (percentage < 80) return 'text-yellow-500'
    if (percentage < 95) return 'text-orange-500'
    return 'text-red-500'
  }

  if (isLoading || !contextLimit) {
    return (
      <div className="flex items-center gap-2">
        <div className="relative w-5 h-5 flex-shrink-0 opacity-50" title="Context limit not available">
          <svg className="w-5 h-5 -rotate-90 transform" viewBox="0 0 24 24">
            <circle
              className="text-muted-foreground/30"
              strokeWidth="2.5"
              stroke="currentColor"
              fill="transparent"
              r="10"
              cx="12"
              cy="12"
            />
            <circle
              className="text-muted-foreground"
              strokeWidth="2.5"
              strokeDasharray={2 * Math.PI * 10}
              strokeDashoffset={2 * Math.PI * 10}
              strokeLinecap="round"
              stroke="currentColor"
              fill="transparent"
              r="10"
              cx="12"
              cy="12"
            />
          </svg>
        </div>
      </div>
    )
  }

  const percentage = Math.min(usagePercentage || 0, 100)
  const isCritical = percentage >= 95
  const isWarning = percentage >= 85 && percentage < 95
  const circumference = 2 * Math.PI * 10
  const strokeDashoffset = circumference - (percentage / 100) * circumference

  return (
    <div
      className={`relative w-5 h-5 flex-shrink-0 group ${isCritical ? 'animate-pulse' : ''}`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <svg className="w-5 h-5 -rotate-90 transform" viewBox="0 0 24 24">
        <circle
          className="text-muted-foreground/30"
          strokeWidth="2.5"
          stroke="currentColor"
          fill="transparent"
          r="10"
          cx="12"
          cy="12"
        />
        <circle
          className={`${getUsageColor(percentage)} ${isCritical ? 'animate-pulse' : ''}`}
          strokeWidth="2.5"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          strokeLinecap="round"
          stroke="currentColor"
          fill="transparent"
          r="10"
          cx="12"
          cy="12"
          style={{ transition: 'stroke-dashoffset 0.3s ease' }}
        />
      </svg>
      <span className={`absolute inset-0 flex items-center justify-center text-[7px] font-medium ${getUsageColor(percentage)}`}>
        {Math.round(percentage)}%
      </span>
      {isHovered && (
        <div className="absolute top-full left-1/2 -translate-x-1/2 mt-1 px-3 py-2 bg-background border border-border rounded text-xs whitespace-nowrap z-10 shadow-lg min-w-[200px]">
          <div>{totalTokens.toLocaleString()} / {contextLimit.toLocaleString()} tokens</div>
          <div className="text-muted-foreground">{percentage.toFixed(1)}% used</div>
          {isWarning && <div className="text-yellow-600 dark:text-yellow-400 font-medium mt-1">Warning: limit close — clean up the conversation</div>}
          {isCritical && <div className="text-red-500 font-bold mt-1">Exceeded: sending blocked — use Scissors to truncate or run compact</div>}
        </div>
      )}
    </div>
  )
}