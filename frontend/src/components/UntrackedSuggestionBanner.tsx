import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { GitBranchPlus, X } from 'lucide-react'
import { useGitStatus } from '@/api/git'

export function UntrackedSuggestionBanner() {
  const { id } = useParams<{ id: string }>()
  const repoId = id ? parseInt(id, 10) : undefined
  const { data: status } = useGitStatus(Number.isNaN(repoId as number) ? undefined : repoId)
  const [dismissed, setDismissed] = useState(false)

  const untrackedCount =
    status?.files?.filter((f) => f.status === 'untracked' && !f.staged).length ?? 0

  if (dismissed || untrackedCount === 0) return null

  return (
    <div className="flex items-center gap-2 px-4 py-2 text-xs border-b bg-accent/40 text-muted-foreground">
      <GitBranchPlus className="w-4 h-4 flex-shrink-0 text-muted-foreground" />
      <span className="flex-1 min-w-0">
        추적되지 않은 파일이 {untrackedCount}개 있습니다. 작업을 저장하려면 커밋하거나 Git 패널에서
        확인하세요.
      </span>
      <button
        onClick={() => setDismissed(true)}
        className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
        title="닫기"
        aria-label="배너 닫기"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}
