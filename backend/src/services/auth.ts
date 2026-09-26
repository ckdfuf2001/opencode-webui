import { promises as fs } from 'fs'
import path from 'path'
import { getAuthPath } from '@opencode-webui/shared'
import { logger } from '../utils/logger'
import { AuthCredentialsSchema } from '../../../shared/src/schemas/auth'
import type { z } from 'zod'

type AuthCredentials = z.infer<typeof AuthCredentialsSchema>
type AuthEntry = AuthCredentials[string]

export class AuthService {
  private authPath = getAuthPath()

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
