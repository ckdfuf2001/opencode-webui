import { promises as fs } from 'fs'
import path from 'path'
import { getAuthPath, getWorkspacePath } from '@opencode-webui/shared'
import { logger } from '../utils/logger'
import { AuthCredentialsSchema } from '../../../shared/src/schemas/auth'
import type { z } from 'zod'

type AuthCredentials = z.infer<typeof AuthCredentialsSchema>
type AuthEntry = AuthCredentials[string]

export class AuthService {
  private authPath = getAuthPath()

  /**
   * 예전 webui 가 쓰던 workspace 안쪽 경로. opencode 는 이 파일을 읽지 않아서
   * 키가 여기만 있으면 조용히 401 이 났다. 새 경로가 비었을 때만 읽어 이어받는다.
   */
  private legacyAuthPath(): string {
    return path.join(getWorkspacePath(), '.opencode', 'state', 'opencode', 'auth.json')
  }

  private async migrateLegacyIfEmpty(): Promise<void> {
    try {
      const current = await this.getAll()
      if (Object.keys(current).length > 0) return
      if (this.legacyAuthPath() === this.authPath) return
      const raw = await fs.readFile(this.legacyAuthPath(), 'utf-8')
      const parsed = JSON.parse(raw)
      const entries = AuthCredentialsSchema.parse(parsed)
      if (Object.keys(entries).length === 0) return
      await fs.mkdir(path.dirname(this.authPath), { recursive: true })
      await fs.writeFile(this.authPath, JSON.stringify(entries, null, 2), { mode: 0o600 })
      logger.warn(
        `Migrated provider credentials from legacy path ${this.legacyAuthPath()} to ${this.authPath} `
        + '(opencode only reads the latter)',
      )
    } catch {
      // 없거나 읽을 수 없으면 무시 — 신규 설치에서는 정상
    }
  }

  async getAll(): Promise<AuthCredentials> {
    try {
      const data = await fs.readFile(this.authPath, 'utf-8')
      const parsed = JSON.parse(data)
      const credentials = AuthCredentialsSchema.parse(parsed)
      // 구버전 webui 형식({ type: 'apiKey', apiKey })을 opencode 형식으로 정규화한다.
      // 스키마가 type 을 "api"|"oauth" 로만 허용하므로, 구버전 파일은 파싱 단계에서
      // 걸러지지 않고 apiKey 필드만 남는다 — 그 필드가 곧 구버전 신호다.
      // 정규화만 하고 아직 다시 쓰지는 않는다. 실제 파일 마이그레이션은 다음 set() 이 한다.
      let migrated = false
      for (const entry of Object.values(credentials)) {
        if (entry && !entry.key && entry.apiKey) {
          entry.type = 'api'
          entry.key = entry.apiKey
          delete entry.apiKey
          migrated = true
        }
      }
      if (migrated) {
        logger.info('Migrated legacy provider credentials to opencode auth format (type=api/key)')
      }
      return credentials
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {}
      }
      logger.error('Failed to read auth.json:', error)
      return {}
    }
  }

  async set(providerId: string, apiKey: string): Promise<void> {
    await this.migrateLegacyIfEmpty()
    const auth = await this.getAll()
    // opencode 가 실제로 읽는 형식. type:'apiKey'/apiKey 로 쓰면 opencode 가
    // 무시해서 요청에 Authorization 헤더가 붙지 않는다 (401).
    auth[providerId] = {
      type: 'api',
      key: apiKey,
    }

    await fs.mkdir(path.dirname(this.authPath), { recursive: true })
    await fs.writeFile(this.authPath, JSON.stringify(auth, null, 2), { mode: 0o600 })

    logger.info(`Set credentials for provider: ${providerId} (opencode auth format)`)
  }

  async delete(providerId: string): Promise<void> {
    const auth = await this.getAll()
    delete auth[providerId]

    await fs.writeFile(this.authPath, JSON.stringify(auth, null, 2), { mode: 0o600 })
    logger.info(`Deleted credentials for provider: ${providerId}`)
  }

  async list(): Promise<string[]> {
    const auth = await this.getAll()
    return Object.keys(auth)
  }

  async has(providerId: string): Promise<boolean> {
    const auth = await this.getAll()
    return !!auth[providerId]
  }

  async get(providerId: string): Promise<AuthEntry | null> {
    const auth = await this.getAll()
    return auth[providerId] || null
  }

  /** 저장된 API 키 값 (구버전/신버전 형식 모두). */
  async getApiKey(providerId: string): Promise<string | null> {
    const entry = await this.get(providerId)
    if (!entry) return null
    if (typeof entry.key === 'string' && entry.key) return entry.key
    if (typeof entry.apiKey === 'string' && entry.apiKey) return entry.apiKey
    return null
  }
}
