import React from 'react'

interface ErrorBoundaryProps {
  children: React.ReactNode
  /** 크래시 시 대신 보여줄 UI. 없으면 조용한 플레이스홀더. */
  fallback?: React.ReactNode
  /** 파트 단위 식별자 (로그용) */
  label?: string
}

interface ErrorBoundaryState {
  error: Error | null
}

/**
 * 렌더 크래시 격리막. 프론트에 경계가 없어서 메시지 파트 하나가 터지면
 * 세션 화면 전체가 언마운트되던 문제를 막는다.
 */
export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error): void {
    try {
      console.error(`[ErrorBoundary${this.props.label ? `:${this.props.label}` : ''}]`, error)
    } catch {
      // 무시
    }
  }

  render(): React.ReactNode {
    if (this.state.error) {
      if (this.props.fallback !== undefined) return this.props.fallback
      return (
        <div className="my-2 rounded border border-red-500/30 bg-red-500/5 p-3 text-xs text-red-300">
          이 부분을 표시하지 못했습니다 ({this.state.error.message || 'render error'}).
          새로고침하면 정상으로 돌아옵니다.
        </div>
      )
    }
    return this.props.children
  }
}
