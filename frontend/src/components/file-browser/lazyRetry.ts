import { lazy } from 'react'

/**
 * 일시적 청크 로드 실패(vite dev HMR 타이밍·loopback 일시 거부 등)에 대비한 lazy.
 * 실패하면 최대 retries번 재시도하고 그래도 안 되면 throw한다.
 * 거부 창이 길 수 있어 백오프를 넉넉히 둔다 (최대 약 15초 커버).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyWithRetry<T extends React.ComponentType<any>>(
  load: () => Promise<{ default: T }>,
  retries = 5,
): React.LazyExoticComponent<T> {
  let attempt = 0
  const tryLoad = (): Promise<{ default: T }> =>
    load().catch((e: unknown) => {
      attempt += 1
      if (attempt > retries) throw e
      return new Promise<{ default: T }>((resolve, reject) => {
        setTimeout(() => {
          tryLoad().then(resolve, reject)
        }, 1000 * attempt)
      })
    })
  return lazy(tryLoad)
}
