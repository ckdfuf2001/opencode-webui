/**
 * 슬라이드 위치 게시 게이트 (W1).
 *
 * 배경: lib은 파일 로드/마운트 직후 resolveInitialSlideIndex(initialSlide 없으면 0)
 * 로 setActiveSlideIndex를 호출하고(pptx-react-viewer chunk-552NAFTD.js:4621 +
 * ooxml-ui chunk-MCHPNO42.mjs VIEWER_ROOT_OPTION_DEFAULTS.initialSlide = 0),
 * [activeSlideIndex] deps effect로 0을 1회 내보낸다(:11259-11263).
 * 즉 "리렌더성 0"과 "사용자가 1번 슬라이드로 이동한 0"이 같은 값으로 온다.
 *
 * 규칙(W1-a/b):
 *  - 화면 상태(cur)는 인덱스 값과 무관하게 **항상 즉시** 반영한다.
 *    썸네일 하이라이트·저장 위치 같은 로컬 UI를 늦출 이유가 없다.
 *  - awareness 게시만 늦춘다: 1 이상은 즉시, 0은 delayMs 뒤에 실행 시점의
 *    cur를 다시 확인해 결정한다(튀는 0이면 보류, 실제 이동이면 게시).
 *  - 예약은 하나뿐이며, 새 예약 전에 항상 취소한다.
 *
 * 규칙(Y2): arm 전에는 아무 인덱스도 받지 않는다.
 *  - activeSlideIndex의 useState 초기값은 0이다(chunk-552NAFTD.js:4104)이고
 *    [activeSlideIndex, onActiveSlideChange] deps effect(:11259)는 parse 전에
 *    mount와 동시에 0을 내보낸다. arm 전에 반영하면 parse가 300ms보다 오래 걸릴
 *    때 위치가 0으로 되돌아가 상대 화면에 "슬라이드 1"로 깜빡인다.
 *  - arm 신호는 onSlideCountChange(count > 0)이 유일하게 trustworthy하다
 *    (deps가 [slides.length]이므로 parse 전 0으로도 호출된다).
 */
export interface SlideGateOptions {
  /** 실행 시점의 실제 슬라이드 인덱스(0-based)를 읽는다. */
  getCurrent: () => number
  /** 확정된 위치를 게시한다 (0-based 인덱스). */
  publish: (index0: number) => void
  /** 화면 상태를 즉시 반영한다 (0-based 인덱스). */
  applyLocal?: (index0: number) => void
  /** 0 게시 지연 (기본 300ms). */
  delayMs?: number
}

export interface SlideGate {
  /** lib의 onActiveSlideChange에서 0-based 인덱스를 그대로 받는다. */
  onIndex: (index0: number) => void
  /**
   * parse 완료를 알렸을 때 호출. arm 전에는 들어오는 인덱스를 전부 무시한다.
   * (lib은 parse 전에 activeSlideIndex 초기값 0을 내보낸다 — chunk-552NAFTD.js:4104 + :11259)
   */
  arm: () => void
  /** viewer가 새로 마운트될 때 호출. 다음 arm까지 모든 입력을 무시한다. */
  disarm: () => void
  armed: () => boolean
  /** 언마운트·세션 교체 시 호출. */
  dispose: () => void
  /** 예약 중인지 (테스트/디버그용). */
  pending: () => boolean
}

export function createSlideGate(opts: SlideGateOptions): SlideGate {
  const delayMs = opts.delayMs ?? 300
  let timer: ReturnType<typeof setTimeout> | null = null
  // 기본값 false: 새 게이트는 "덱이 아직 파싱되지 않은" 상태에서 시작한다.
  // 파싱 전 lib이 내보내는 0을 사용자의 이동으로 오인하지 않으�� 위한 안전 기본값.
  let armed = false
  const cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
  return {
    onIndex(index0: number): void {
      // Y2: arm 전 인덱스는 로컬 반영도 게시도 하지 않는다.
      if (!armed) return
      const i = Number.isFinite(index0) ? Math.max(0, Math.floor(index0)) : 0
      // W1-a: 로컬 상태는 조건 없이 즉시 반영한다.
      opts.applyLocal?.(i)
      if (i >= 1) {
        // 사용자의 실제 이동: 예약 취소 후 즉시 게시.
        cancel()
        opts.publish(i)
        return
      }
      // i === 0: 리렌더성 튐일 수 있어 예약한다.
      cancel()
      timer = setTimeout(() => {
        timer = null
        // 실행 시점의 실제 상태로 판정한다 (콜백 값이 아니라).
        if (opts.getCurrent() === 0) opts.publish(0)
      }, delayMs)
    },
    arm(): void {
      armed = true
    },
    disarm(): void {
      armed = false
      cancel()
    },
    armed: () => armed,
    dispose: cancel,
    pending: () => timer !== null,
  }
}