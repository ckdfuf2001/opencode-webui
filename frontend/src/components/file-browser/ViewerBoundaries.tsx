import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { VIEWER_RETRY_MAX, consumeRetryBudget } from '@/lib/viewerRecovery'

/**
 * 에러 바운더리 격리 모듈.
 * 클래스 컴포넌트는 react-refresh HMR이 처리하지 못해 전체 페이지 리로드가
 * 나므로, 자주 바뀌는 뷰어 파일과 분리한다 (여기는 거의 손대지 않는다).
 */

/** 자동 재시도 간격. 성공 판정 유예 (lib 초기화가 느려도 오판하지 않게 넉넉히). */
const RETRY_DELAY_MS = 1000
const SETTLE_MS = 8000

/** 뷰어 청크 로드 실패 시 다시 시도/PDF 폴백을 보여준다. 원인 문구도 표시한다. */
export class ViewerLoadBoundary extends Component<
  { onRetry: () => void; onPdf?: () => void; children: ReactNode },
  { failed: boolean; message: string; stack: string; seq: number; autoLeft: number; autoRunning: boolean }
> {
  state = { failed: false, message: '', stack: '', seq: 0, autoLeft: 0, autoRunning: false }
  private autoTried = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private settleTimer: ReturnType<typeof setTimeout> | null = null
  private onOnline = () => {
    // 네트워크 복귀 시 1회 자동 재시도 (VPN 플랩 등, 클릭 없이 복구).
    if (this.state.failed && !this.autoTried) {
      this.autoTried = true
      this.props.onRetry()
    }
  }
  private onVis = () => {
    if (document.visibilityState === 'visible') this.onOnline()
  }

  static getDerivedStateFromError(): { failed: boolean; message: string; stack: string } {
    return { failed: true, message: '', stack: '' }
  }
  componentDidCatch(error: Error, info: ErrorInfo): void {
    try {
      console.error('[viewer-boundary]', error, info?.componentStack ?? '')
    } catch {
      /* 무시 */
    }
    this.setState({
      message: error instanceof Error ? error.message : String(error),
      stack: info?.componentStack ?? '',
    })
    // 자동 재시도 예산이 남았으면 예약한다 (수동 클릭 없이 이어서 시도).
    if (this.settleTimer) {
      clearTimeout(this.settleTimer)
      this.settleTimer = null
    }
    const budget = consumeRetryBudget(this.state.autoLeft)
    this.setState({ autoLeft: budget.left })
    if (budget.retry) {
      this.setState({ autoRunning: true })
      if (this.retryTimer) clearTimeout(this.retryTimer)
      this.retryTimer = setTimeout(() => {
        this.retryTimer = null
        this.doAttempt()
      }, RETRY_DELAY_MS)
    } else {
      this.setState({ autoRunning: false })
    }
  }
  /** 재시도 1회: 자식을 새로 마운트하고(parent onRetry 유지) 성공 유예를 건다. */
  private doAttempt = (): void => {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.setState((s) => ({ failed: false, message: '', stack: '', seq: s.seq + 1 }))
    try {
      this.props.onRetry()
    } catch {
      /* 무시 */
    }
    if (this.settleTimer) clearTimeout(this.settleTimer)
    // 유예 안에 에러가 없으면 성공으로 보고 예산을 회수한다 (늦은 무관 에러가
    // 자동 재시도를 타지 않게 — 버스트 윈도우로 한정).
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null
      this.setState({ autoRunning: false, autoLeft: 0 })
    }, SETTLE_MS)
  }
  /** Retry 클릭: 예산을 새로 채우고 최대 3회까지 자동으로 시도한다. */
  private onRetryClick = (): void => {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    if (this.settleTimer) {
      clearTimeout(this.settleTimer)
      this.settleTimer = null
    }
    this.setState({ autoLeft: VIEWER_RETRY_MAX, autoRunning: true })
    this.doAttempt()
  }
  private clearTimers(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    if (this.settleTimer) {
      clearTimeout(this.settleTimer)
      this.settleTimer = null
    }
  }
  componentDidMount(): void {
    window.addEventListener('online', this.onOnline)
    document.addEventListener('visibilitychange', this.onVis)
  }
  componentWillUnmount(): void {
    window.removeEventListener('online', this.onOnline)
    document.removeEventListener('visibilitychange', this.onVis)
    this.clearTimers()
  }
  render(): ReactNode {
    // seq 키로 자식을 감싸 재시도 때마다 새로 마운트한다
    // (AttachmentEditor처럼 바깥 key가 없는 경로에서도 Retry가 동작하게).
    if (!this.state.failed) return <Fragment key={this.state.seq}>{this.props.children}</Fragment>
    const tried = VIEWER_RETRY_MAX - this.state.autoLeft
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-2 text-center px-6">
        <p className="text-sm text-muted-foreground">Failed to load preview.</p>
        {this.state.autoRunning ? (
          <p className="text-[11px] text-muted-foreground/70">
            다시 시도 중… ({tried}/{VIEWER_RETRY_MAX})
          </p>
        ) : (
          <>
            {this.state.message && (
              <p className="text-[11px] text-muted-foreground/70 font-mono break-all max-w-md">{this.state.message}</p>
            )}
          </>
        )}
        {this.state.stack && !this.state.autoRunning && (
          <details className="max-w-md text-left">
            <summary className="cursor-pointer text-[11px] text-muted-foreground/70">component stack</summary>
            <pre className="whitespace-pre-wrap break-all text-[10px] text-muted-foreground/70 font-mono">{this.state.stack}</pre>
          </details>
        )}
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={this.onRetryClick} disabled={this.state.autoRunning}>
            {this.state.autoRunning ? `재시도 중… (${tried}/${VIEWER_RETRY_MAX})` : 'Retry'}
          </Button>
          {this.props.onPdf && (
            <Button size="sm" variant="outline" onClick={this.props.onPdf}>
              View as PDF
            </Button>
          )}
        </div>
      </div>
    )
  }
}

/** pptx 엔진 내부 오류를 삼키고 onFail(PDF 폴백 등)으로 넘긴다. */
export class PptxViewerBoundary extends Component<
  { onFail: () => void; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  componentDidCatch(): void {
    this.props.onFail()
  }
  render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}
