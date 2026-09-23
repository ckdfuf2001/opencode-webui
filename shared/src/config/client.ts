import { DEFAULTS, ALLOWED_MIME_TYPES, GIT_PROVIDERS } from './defaults'

export interface ClientConfig {
  API_BASE_URL: string
  SERVER_PORT: number
  OPENCODE_PORT: number
  FILE_LIMITS: {
    MAX_SIZE_BYTES: number
    MAX_UPLOAD_SIZE_BYTES: number
  }
}

export function createClientConfig(env: {
  VITE_API_URL?: string
  VITE_SERVER_PORT?: string
  VITE_OPENCODE_PORT?: string
  VITE_MAX_FILE_SIZE_MB?: string
  VITE_MAX_UPLOAD_SIZE_MB?: string
}): ClientConfig {
  const maxFileSizeMB = env.VITE_MAX_FILE_SIZE_MB 
    ? parseInt(env.VITE_MAX_FILE_SIZE_MB, 10) 
    : DEFAULTS.FILE_LIMITS.MAX_SIZE_MB
  
  const maxUploadSizeMB = env.VITE_MAX_UPLOAD_SIZE_MB 
    ? parseInt(env.VITE_MAX_UPLOAD_SIZE_MB, 10) 
    : DEFAULTS.FILE_LIMITS.MAX_UPLOAD_SIZE_MB

  const serverPort = env.VITE_SERVER_PORT 
    ? parseInt(env.VITE_SERVER_PORT, 10) 
    : DEFAULTS.SERVER.PORT

  return {
    API_BASE_URL: env.VITE_API_URL || '',
    SERVER_PORT: serverPort,
    OPENCODE_PORT: env.VITE_OPENCODE_PORT
      ? parseInt(env.VITE_OPENCODE_PORT, 10)
      : DEFAULTS.OPENCODE.PORT,
    FILE_LIMITS: {
      MAX_SIZE_BYTES: maxFileSizeMB * 1024 * 1024,
      MAX_UPLOAD_SIZE_BYTES: maxUploadSizeMB * 1024 * 1024,
    },
  }
}

/**
 * 런타임 API base 확정 (v0.12.1, Connected 오판 방지).
 * VITE_API_URL은 빌드 타임에 구워지므로, 구운 절대 URL(localhost)이
 * 페이지를 서빙한 백엔드와 다른 머신/포트를 가리키면 Connected가
 * 엉뚱한 (건강한) 백엔드를 보고 꺼지지 않는다.
 * 규칙: 페이지가 http(s) + 비-loopback 호스트에서 서빙되면,
 * 구운 값이 비어있거나 loopback을 가리킬 때 same-origin('')으로 강제한다.
 * 명시적 원격 URL(구운 host가 loopback이 아님)은 존중한다 (원격 백엔드 지정 용도).
 */
export function resolveRuntimeApiBase(args: {
  baked?: string
  pageProtocol?: string
  pageHostname?: string
}): string {
  const baked = (args.baked ?? '').trim()
  const protocol = (args.pageProtocol ?? '').toLowerCase()
  const host = (args.pageHostname ?? '').toLowerCase()
  const servedOverHttp = protocol === 'http:' || protocol === 'https:'
  if (!servedOverHttp || isLoopbackHost(host)) return baked
  if (!baked) return ''
  try {
    if (isLoopbackHost(new URL(baked).hostname)) return ''
  } catch {
    return baked
  }
  return baked
}

function isLoopbackHost(host: string): boolean {
  const h = (host ?? '').toLowerCase()
  return h === '' || h === 'localhost' || h === '127.0.0.1' || h === '::1'
}

export { isLoopbackHost }

export { DEFAULTS, ALLOWED_MIME_TYPES, GIT_PROVIDERS }
