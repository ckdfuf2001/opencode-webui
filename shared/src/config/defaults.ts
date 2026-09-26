export const DEFAULTS = {
  SERVER: {
    PORT: 5002,
    HOST: '0.0.0.0',
    CORS_ORIGIN: 'http://localhost:5173',
  },

  FRONTEND: {
    PORT: 5173,
    HOST: '0.0.0.0',
  },

  OPENCODE: {
    PORT: 5552,
    HOST: '127.0.0.1',
    BIN: 'opencode',
  },

  DATABASE: {
    PATH: './data/opencode.db',
  },

  WORKSPACE: {
    BASE_PATH: './workspace',
    REPOS_DIR: 'repos',
    CONFIG_DIR: '.config/opencode',
    // 빈 값 = opencode 네이티브 데이터 디렉터리를 쓴다 (getAuthPath 참고).
    // 예전 값('.opencode/state/opencode/auth.json') 은 opencode 가 읽지 않아서
    // provider 키가 저장돼도 요청에 붙지 않았다(401). 여기 경로를 직접 지정하면
    // 그때는 또 opencode 와 어긋난다 — 비워둔다.
    AUTH_FILE: '',
  },

  TIMEOUTS: {
    PROCESS_START_WAIT_MS: 2000,
    PROCESS_VERIFY_WAIT_MS: 1000,
    HEALTH_CHECK_INTERVAL_MS: 5000,
    HEALTH_CHECK_TIMEOUT_MS: 30000,
  },

  FILE_LIMITS: {
    MAX_SIZE_MB: 50,
    MAX_UPLOAD_SIZE_MB: 50,
  },

  LOGGING: {
    DEBUG: false,
    LOG_LEVEL: 'info',
  },
} as const

export const ALLOWED_MIME_TYPES = [
  'text/plain',
  'text/html',
  'text/css',
  'text/javascript',
  'text/typescript',
  'application/json',
  'application/xml',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/svg+xml',
  'application/pdf',
  'application/zip',
] as const

export const GIT_PROVIDERS = {
  GITHUB: 'github.com',
  GITLAB: 'gitlab.com',
  BITBUCKET: 'bitbucket.org',
} as const

export type Config = typeof DEFAULTS
export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number]
export type GitProvider = (typeof GIT_PROVIDERS)[keyof typeof GIT_PROVIDERS]
