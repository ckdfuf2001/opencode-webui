import { Component, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'

/**
 * 에러 바운더리 격리 모듈.
 * 클래스 컴포넌트는 react-refresh HMR이 처리하지 못해 전체 페이지 리로드가
 * 나므로, 자주 바뀌는 뷰어 파일과 분리한다 (여기는 거의 손대지 않는다).
 */

/** 뷰어 청크 로드 실패 시 다시 시도/PDF 폴백을 보여준다. 원인 문구도 표시한다. */
export class ViewerLoadBoundary extends Component<
  { onRetry: () => void; onPdf?: () => void; children: ReactNode },
  { failed: boolean; message: string }
> {
  state = { failed: false, message: '' }
  private autoTried = false
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

  static getDerivedStateFromError(): { failed: boolean; message: string } {
    return { failed: true, message: '' }
  }
  componentDidCatch(error: unknown): void {
    this.setState({ message: error instanceof Error ? error.message : String(error) })
  }
  componentDidMount(): void {
    window.addEventListener('online', this.onOnline)
    document.addEventListener('visibilitychange', this.onVis)
  }
  componentWillUnmount(): void {
    window.removeEventListener('online', this.onOnline)
    document.removeEventListener('visibilitychange', this.onVis)
  }
  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-2 text-center px-6">
        <p className="text-sm text-muted-foreground">Failed to load preview.</p>
        {this.state.message && (
          <p className="text-[11px] text-muted-foreground/70 font-mono break-all max-w-md">{this.state.message}</p>
        )}
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={this.props.onRetry}>
            Retry
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
