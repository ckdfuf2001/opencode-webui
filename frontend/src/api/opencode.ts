import axios, { type AxiosInstance } from 'axios'
import type { components, paths } from './opencode-types'
import { showToast } from '@/lib/toast'
import { clearQueuedChats } from './chat-queue'

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

export class OpenCodeClient {
  private client: AxiosInstance
  private baseURL: string
  private directory?: string
  private static lastTimeoutWarn: Record<string, number> = {}

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
          const sessionID = error.config.url.match(/\/session\/([^/]+)/)?.[1] ?? null
          // 세션별 토스트 중복 억제: 10분 내 재경고 없음
          const now = Date.now()
          const last = OpenCodeClient.lastTimeoutWarn[sessionID ?? ''] ?? 0
          if (now - last > 10 * 60 * 1000) {
            OpenCodeClient.lastTimeoutWarn[sessionID ?? ''] = now
            try {
              const healthy = await this.checkServerHealth()
              const port = this.baseURL != null && this.baseURL.includes(':') ? this.baseURL!.split(':').pop()!.split('/')[0] : 'unknown'
              const msg = `Answer is generating over Timeout 600 sec, Backend is ${healthy ? 'alived' : 'not alived'} at port ${port}`
              console.warn(msg)
              showToast.warning(msg)
            } catch (checkError) {
              console.error('Health check error:', checkError)
            }
          }
          // 600s 타임아웃 = 응답 대기를 포기한다는 뜻. 서버 쪽 생성도
          // 실제로 중단시키고, 대기열(자동 발송)까지 비워야 stop 없이도 깔끔히 끝난다.
          if (sessionID) {
            try {
              await this.client.post(`/session/${sessionID}/abort`, undefined, { timeout: 10_000 })
            } catch (abortError) {
              console.warn('Failed to abort session after timeout:', abortError)
            }
            try {
              clearQueuedChats(sessionID)
            } catch {
              // 큐 정리 실패는 무시
            }
          }
          return Promise.resolve({}) // Return empty to prevent chat error display
        }
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
    await this.client.post(`/session/${sessionID}/abort`)
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
        // 메타 조회: 벤더(provider) 응답이 느려도 UI가 멈추지 않도록 짧은 타임아웃
        const response = await this.client.get<ConfigResponse>('/config', { timeout: 10_000 })
        return response.data
      }

  async updateConfig(config: Partial<ConfigResponse>) {
    const response = await this.client.patch<ConfigResponse>('/config', config)
    return response.data
  }

      async getProviders() {
        const response = await this.client.get('/config/providers', { timeout: 10_000 })
        return response.data
      }

  async listCommands() {
    // opencode 서버가 생성 중일 때 /command 가 늦게 응답할 수 있다.
    // 백엔드 프록시가 8s 후 stale 캐시로 응답하므로 그보다 길게 대기한다.
    const response = await this.client.get<CommandListResponse>('/command', { timeout: 25_000 })
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
    const result = await this.client.post(`/session/${sessionID}/permissions/${permissionID}`, { response })
    return result.data
  }

  async listPermissions() {
    const response = await this.client.get<Permission[]>('/permission')
    return response.data
  }

  async respondToPermissionV2(requestID: string, response: 'once' | 'always' | 'reject') {
    const result = await this.client.post(`/permission/${requestID}/reply`, { reply: response })
    return result.data
  }

  async listQuestions() {
    const response = await this.client.get('/question')
    return response.data
  }

  async replyToQuestion(requestID: string, answers: string[][]) {
    const result = await this.client.post(`/question/${requestID}/reply`, { answers })
    return result.data
  }

  async rejectQuestion(requestID: string) {
    const result = await this.client.post(`/question/${requestID}/reject`)
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

