import fs from 'node:fs'

/**
 * 규칙 0: 테스트가 만든 임시 WORKSPACE는 실행이 끝나면 반드시 지운다.
 * config가 mkdtempSync로 만든 COLLAB_E2E_WS 경로를 그대로 제거한다.
 */
export default function globalTeardown(): void {
  const dir = process.env.COLLAB_E2E_WS
  if (!dir) return
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // 정리 실패는 테스트 결과를 바꾸지 않는다.
  }
}