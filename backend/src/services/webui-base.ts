import { DEFAULTS } from '@opencode-webui/shared'

let webuiPort: number = DEFAULTS.SERVER.PORT

/** 실제 바인드된 백단 포트 (prepareBackendPort 이후 확정값). */
export function setWebuiPort(port: number): void {
  if (Number.isFinite(port) && port > 0) webuiPort = port
}

/** 토스트 클릭 이동용 프론트 base URL (같은 PC). */
export function getWebuiBaseUrl(): string {
  return `http://localhost:${webuiPort}`
}

/** 세션 딥링크 경로 (프론트 라우트와 동일). */
export function sessionWebPath(repoId: number | null, sessionId: string): string {
  return repoId != null ? `/repos/${repoId}/sessions/${sessionId}` : `/session/${sessionId}`
}
