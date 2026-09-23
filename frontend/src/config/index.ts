import { createClientConfig, resolveRuntimeApiBase, DEFAULTS, ALLOWED_MIME_TYPES, GIT_PROVIDERS } from '../../../shared/src/config/client'

const config = createClientConfig({
  VITE_API_URL: import.meta.env.VITE_API_URL,
  VITE_SERVER_PORT: import.meta.env.VITE_SERVER_PORT,
  VITE_OPENCODE_PORT: import.meta.env.VITE_OPENCODE_PORT,
  VITE_MAX_FILE_SIZE_MB: import.meta.env.VITE_MAX_FILE_SIZE_MB,
  VITE_MAX_UPLOAD_SIZE_MB: import.meta.env.VITE_MAX_UPLOAD_SIZE_MB,
})

// 빌드 타임에 구워진 loopback 절대 URL이 서빙 백엔드와 어긋나면
// Connected가 엉뚱한 백엔드를 보고 꺼지지 않는다 — 런타임에 확정한다.
const runtimeBase = typeof window !== 'undefined' && window.location
  ? resolveRuntimeApiBase({
      baked: config.API_BASE_URL,
      pageProtocol: window.location.protocol,
      pageHostname: window.location.hostname,
    })
  : config.API_BASE_URL

export const API_BASE_URL = runtimeBase
export const OPENCODE_API_ENDPOINT = `${config.API_BASE_URL}/api/opencode`
export const SERVER_PORT = config.SERVER_PORT
export const OPENCODE_PORT = config.OPENCODE_PORT
export const FILE_LIMITS = config.FILE_LIMITS

export { DEFAULTS, ALLOWED_MIME_TYPES, GIT_PROVIDERS }
export default config
