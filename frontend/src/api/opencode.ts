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
  private static sessionTimers: Record<string, ReturnType<typeof setInterval>> = {}
  private static firstTimeoutAt: Record<string, number> = {}
  private static lastWarnedBoundary: Record<string, number> = {}

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
          if (sessionID) {
            // 최초 타임아웃 시점을 기준으로 10분 경계를 계산해
            // 경계가 늘어날 때만(10분→20분→30분) 1회씩 경고한다.
            OpenCodeClient.firstTimeoutAt[sessionID] ??= Date.now()
            const elapsed = Date.now() - OpenCodeClient.firstTimeoutAt[sessionID]
            const boundary = Math.max(1, Math.floor(elapsed / 600_000))
            const lastBoundary = OpenCodeClient.lastWarnedBoundary[sessionID] ?? 0
            const stillGenerating = await this.isSessionGenerating(sessionID)

            if (boundary > lastBoundary) {
              OpenCodeClient.lastWarnedBoundary[sessionID] = boundary
              try {
                const healthy = await this.checkServerHealth()
                const port = this.baseURL != null && this.baseURL.includes(':') ? this.baseURL!.split(':').pop()!.split('/')[0] : 'unknown'
                const msg = boundary === 1
                  ? `Answer is generating over Timeout 600 sec, Backend is ${healthy ? 'alived' : 'not alived'} at port ${port}`
                  : `Answer is still generating (${boundary * 10} min elapsed)`
                console.warn(msg)
                showToast.warning(msg)
              } catch (checkError) {
                console.error('Health check error:', checkError)
              }
            }

            // 백엔드 응답 불가/세션 종료일 때만 중단+큐 비움.
            // 생성 진행 중이면 건드리지 않고 워치독이 10분 단위 추적한다.
            if (!stillGenerating) {
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
              // 세션 정리: 다음 장기 실행 때 처음부터 다시 계산
              delete OpenCodeClient.firstTimeoutAt[sessionID]
              delete OpenCodeClient.lastWarnedBoundary[sessionID]
            } else {
              this.ensureGenerationWatchdog(sessionID)
            }
          }
          return Promise.resolve({}) // Return empty to prevent chat error display
        }
        return Promise.reject(error)
      }
    )
  }

  /** 마지막 assistant 메시지가 완료되지 않았으면 아직 생성 중으로 판정한다. */
  private async isSessionGenerating(sessionID: string): Promise<boolean> {
    try {
      const response = await this.client.get(`/session/${sessionID}/message`, { timeout: 8_000 })
      const messages = response.data as Array<{ info: { role?: string; time?: { completed?: number } } }>
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i]
        if (m.info?.role === 'assistant') {
          return !m.info.time?.completed
        }
      }
      return false
    } catch {
      // 서버 응답 불가 → 생성 중으로 판단할 수 없음(false) → 상위에서 중단 경로 처리
      return false
    }
  }

  /** 10분 경계마다 1회씩 경고하며, 생성이 끝나면 자동으로 추적을 멈춘다. */
  private ensureGenerationWatchdog(sessionID: string): void {
    if (OpenCodeClient.sessionTimers[sessionID]) return
    const first = OpenCodeClient.firstTimeoutAt[sessionID] ?? Date.now()
    const timer = setInterval(async () => {
      const elapsed = Date.now() - first
      const boundary = Math.floor(elapsed / 600_000)
      const lastB = OpenCodeClient.lastWarnedBoundary[sessionID] ?? 1
      const generating = await this.isSessionGenerating(sessionID)
      if (!generating) {
        clearInterval(timer)
        delete OpenCodeClient.sessionTimers[sessionID]
        return
      }
      if (boundary > lastB) {
        OpenCodeClient.lastWarnedBoundary[sessionID] = boundary
        showToast.warning(`Answer is still generating (${boundary * 10} min elapsed)`)
      }
    }, 60_000)
    OpenCodeClient.sessionTimers[sessionID] = timer
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
    const response = await this.client.get<CommandListResponse>('/command', { timeout: 12_000 })
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

