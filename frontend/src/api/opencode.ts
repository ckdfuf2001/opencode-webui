import axios, { type AxiosInstance } from 'axios'
import type { components, paths } from './opencode-types'
import { showToast } from '@/lib/toast'

type SessionListResponse = paths['/session']['get']['responses']['200']['content']['application/json']
type SessionResponse = paths['/session/{id}']['get']['responses']['200']['content']['application/json']
type CreateSessionRequest = NonNullable<paths['/session']['post']['requestBody']>['content']['application/json']
type MessageListResponse = paths['/session/{id}/message']['get']['responses']['200']['content']['application/json']
type SendPromptRequest = NonNullable<paths['/session/{id}/message']['post']['requestBody']>['content']['application/json']
type ConfigResponse = paths['/config']['get']['responses']['200']['content']['application/json']
type CommandListResponse = paths['/command']['get']['responses']['200']['content']['application/json']
type CommandRequest = NonNullable<paths['/session/{id}/command']['post']['requestBody']>['content']['application/json']
type ShellRequest = NonNullable<paths['/session/{id}/shell']['post']['requestBody']>['content']['application/json']
type Permission = components['schemas']['Permission']

/**
 * axios 기본 메시지("Request failed with status code 500")는 원인이 안 보인다.
 * 서버(백엔드/프록시/opencode)가 내려주는 error·message·detail 필드를 꺼내
 * error.message 를 실제 사유로 바꿔준다. 토스트·콘솔이 이 값을 그대로 쓴다.
 */
export function enrichAxiosErrorMessage(error: unknown): void {
  if (!error || typeof error !== 'object') return
  const err = error as { message?: string; response?: { status?: number; data?: unknown } }
  if (err.response == null) return
  const data: unknown = err.response.data
  let reason: string | undefined
  if (typeof data === 'string') {
    reason = data.trim() || undefined
  } else if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    // opencode 에러 형태: { name, data: { message, ref } } 도 처리한다.
    const nested = obj.data && typeof obj.data === 'object' ? obj.data as Record<string, unknown> : undefined
    for (const source of [obj, nested ?? {}]) {
      for (const key of ['message', 'error', 'detail']) {
        const v = source[key]
        if (typeof v === 'string' && v.trim() && !v.includes('Check server logs for details')) { reason = v.trim(); break }
        if (v != null && typeof v !== 'object' && !(typeof v === 'string')) { reason = String(v); break }
      }
      if (reason) break
    }
    if (!reason) {
      // zod 등 { details: [...] } 형태 보조 표시
      const details = obj.details ?? obj.issues
      if (details != null) reason = JSON.stringify(details).slice(0, 300)
    }
  }
  if (reason) {
    const status = err.response.status
    err.message = `${reason}${status ? ` (HTTP ${status})` : ''}`
    return
  }
  // 본문이 비어 있어도 어떤 요청이 왜 실패했는지는 알 수 있게 한다.
  const cfg = (err as { response?: { config?: { method?: string; url?: string } } }).response?.config
  if (err.response.status != null) {
    const target = cfg?.url ? ` ${cfg.method?.toUpperCase() ?? 'GET'} ${cfg.url}` : ''
    err.message = `Request failed${target} (HTTP ${err.response.status})`
  }
}

export class OpenCodeClient {
  private client: AxiosInstance
  private baseURL: string
  private directory?: string

  constructor(baseURL: string, directory?: string) {
    this.baseURL = baseURL
    this.directory = directory
    this.client = axios.create({
      baseURL,
      timeout: 600000
    })
    
    this.client.interceptors.request.use((config) => {
      if (this.directory) {
        config.params = { ...config.params, directory: this.directory }
      }
      return config
    })

    this.client.interceptors.response.use(
      (response) => response,
      async (error) => {
        if (error.message?.includes?.('timeout') && error?.config?.url?.includes?.('/session')) {
          try {
            const healthy = await this.checkServerHealth()
            const port = this.baseURL != null && this.baseURL.includes(':') ? this.baseURL!.split(':').pop()!.split('/')[0] : 'unknown'
            const msg = `Answer is generating over Timeout 600 sec, Backend is ${healthy ? 'alived' : 'not alived'} at port ${port}`
            console.warn(msg)
            // Show warning but don't add error to chat - show toast only once
            showToast.warning(msg)
            return Promise.resolve({}) // Return empty to prevent chat error display
          } catch (checkError) {
            // Health check failed, show normal error
            console.error('Health check error:', checkError)
          }
        }
        enrichAxiosErrorMessage(error)
        return Promise.reject(error)
      }
    )
  }

  private async checkServerHealth(): Promise<boolean> {
    try {
      const base = this.baseURL.startsWith('http')
        ? this.baseURL
        : `${window.location.origin}${this.baseURL}`
      const healthUrl = new URL(`${base}/health`)
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 5000)
      const response = await fetch(healthUrl.toString(), { signal: controller.signal })
      clearTimeout(timeoutId)
      return response.ok
    } catch {
      return false
    }
  }

  setDirectory(directory: string) {
    this.directory = directory
  }

  async listSessions() {
    const response = await this.client.get<SessionListResponse>('/session')
    return response.data
  }

  async getSession(sessionID: string) {
    const response = await this.client.get<SessionResponse>(`/session/${sessionID}`)
    return response.data
  }

  async createSession(data: CreateSessionRequest) {
    const response = await this.client.post<SessionResponse>('/session', data)
    return response.data
  }

  async deleteSession(sessionID: string) {
    await this.client.delete(`/session/${sessionID}`)
  }

  async truncateSession(sessionID: string, messageID: string) {
    const response = await this.client.post(`/session/${sessionID}/truncate`, {
      messageID
    })
    return response.data
  }

  async updateSession(sessionID: string, data: { title?: string }) {
    const response = await this.client.patch(`/session/${sessionID}`, data)
    return response.data
  }

  async forkSession(sessionID: string, messageID?: string) {
    const response = await this.client.post<SessionResponse>(`/session/${sessionID}/fork`, {
      messageID
    })
    return response.data
  }

  async abortSession(sessionID: string) {
    await this.client.post(`/session/${sessionID}/abort`, null, { timeout: 10000 })
  }

  async getSessionStatus(): Promise<Record<string, { type: string }>> {
    const response = await this.client.get(`/session/status`)
    return response.data
  }

  async listMessages(sessionID: string) {
    const response = await this.client.get<MessageListResponse>(`/session/${sessionID}/message`)
    return response.data
  }

  async sendPrompt(sessionID: string, data: SendPromptRequest) {
    const response = await this.client.post(`/session/${sessionID}/message`, data)
    return response.data
  }

  async getConfig() {
    const response = await this.client.get<ConfigResponse>('/config')
    return response.data
  }

  async updateConfig(config: Partial<ConfigResponse>) {
    const response = await this.client.patch<ConfigResponse>('/config', config)
    return response.data
  }

  async getProviders() {
    const response = await this.client.get('/config/providers')
    return response.data
  }

  async listCommands(timeoutMs?: number) {
    const response = await this.client.get<CommandListResponse>(
      '/command',
      timeoutMs ? { timeout: timeoutMs } : undefined
    )
    return response.data
  }

  async listAgents() {
    const response = await this.client.get<{ name: string; description?: string }[]>('/agent')
    return response.data
  }

  async sendCommand(sessionID: string, data: CommandRequest) {
    const response = await this.client.post(`/session/${sessionID}/command`, data)
    return response.data
  }

  async switchModel(sessionID: string, model: { id: string; providerID: string }) {
    await this.client.post(`/api/session/${sessionID}/model`, { model })
  }

  async sendShell(sessionID: string, data: ShellRequest) {
    const response = await this.client.post(`/session/${sessionID}/shell`, data)
    return response.data
  }

  async respondToPermission(sessionID: string, permissionID: string, response: 'once' | 'always' | 'reject') {
    const result = await this.client.post(`/session/${sessionID}/permissions/${permissionID}`, { response }, { timeout: 10000 })
    return result.data
  }

  async listPermissions() {
    const response = await this.client.get<Permission[]>('/permission')
    return response.data
  }

  async respondToPermissionV2(requestID: string, response: 'once' | 'always' | 'reject') {
    const result = await this.client.post(`/permission/${requestID}/reply`, { reply: response }, { timeout: 10000 })
    return result.data
  }

  async listQuestions() {
    const response = await this.client.get('/question')
    return response.data
  }

  async replyToQuestion(requestID: string, answers: string[][]) {
    const result = await this.client.post(`/question/${requestID}/reply`, { answers }, { timeout: 10000 })
    return result.data
  }

  async rejectQuestion(requestID: string) {
    const result = await this.client.post(`/question/${requestID}/reject`, null, { timeout: 10000 })
    return result.data
  }

  getEventSourceURL() {
    const base = this.baseURL.startsWith('http') 
      ? this.baseURL 
      : `${window.location.origin}${this.baseURL}`
    const url = new URL(`${base}/event`)
    if (this.directory) {
      url.searchParams.set('directory', this.directory)
    }
    return url.toString()
  }

  getGlobalEventSourceURL() {
    const base = this.baseURL.startsWith('http') 
      ? this.baseURL 
      : `${window.location.origin}${this.baseURL}`
    const url = new URL(`${base}/global/event`)
    return url.toString()
  }
}

export const createOpenCodeClient = (baseURL: string, directory?: string) => {
  return new OpenCodeClient(baseURL, directory)
}
