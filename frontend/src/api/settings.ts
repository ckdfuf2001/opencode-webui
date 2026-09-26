import axios from 'axios'
import type { 
  SettingsResponse, 
  UpdateSettingsRequest, 
  OpenCodeConfig,
  OpenCodeConfigResponse,
  CreateOpenCodeConfigRequest,
  UpdateOpenCodeConfigRequest,
  CustomCommand,
} from './types/settings'
import { API_BASE_URL } from '@/config'

/** 커스텀 provider 등록 payload. openai 호환은 npm + options.baseURL 조합. */
export interface UpsertProviderRequest {
  /** opencode provider id — 소문자/숫자로 시작, . _ - 허용 */
  id: string
  name?: string
  npm?: string
  baseURL?: string
  models?: Record<string, {
    name?: string
    limit?: { context: number; output: number }
    reasoning?: boolean
    tool_call?: boolean
    attachment?: boolean
    temperature?: boolean
  }>
}

export const settingsApi = {
  getSettings: async (userId = 'default'): Promise<SettingsResponse> => {
    const { data } = await axios.get(`${API_BASE_URL}/api/settings`, {
      params: { userId },
    })
    return data
  },

  updateSettings: async (
    updates: UpdateSettingsRequest,
    userId = 'default'
  ): Promise<SettingsResponse> => {
    const { data } = await axios.patch(`${API_BASE_URL}/api/settings`, updates, {
      params: { userId },
    })
    return data
  },

  resetSettings: async (userId = 'default'): Promise<SettingsResponse> => {
    const { data } = await axios.delete(`${API_BASE_URL}/api/settings`, {
      params: { userId },
    })
    return data
  },

  getOpenCodeConfigs: async (userId = 'default'): Promise<OpenCodeConfigResponse> => {
    const { data } = await axios.get(`${API_BASE_URL}/api/settings/opencode-configs`, {
      params: { userId },
    })
    return data
  },

  createOpenCodeConfig: async (
    request: CreateOpenCodeConfigRequest,
    userId = 'default'
  ): Promise<OpenCodeConfig> => {
    const { data } = await axios.post(`${API_BASE_URL}/api/settings/opencode-configs`, request, {
      params: { userId },
    })
    return data
  },

  updateOpenCodeConfig: async (
    configName: string,
    request: UpdateOpenCodeConfigRequest,
    userId = 'default'
  ): Promise<OpenCodeConfig> => {
    const { data } = await axios.put(
      `${API_BASE_URL}/api/settings/opencode-configs/${encodeURIComponent(configName)}`,
      request,
      { params: { userId } }
    )
    return data
  },

  deleteOpenCodeConfig: async (
    configName: string,
    userId = 'default'
  ): Promise<boolean> => {
    await axios.delete(
      `${API_BASE_URL}/api/settings/opencode-configs/${encodeURIComponent(configName)}`,
      { params: { userId } }
    )
    return true
  },

  setDefaultOpenCodeConfig: async (
    configName: string,
    userId = 'default'
  ): Promise<OpenCodeConfig> => {
    const { data } = await axios.post(
      `${API_BASE_URL}/api/settings/opencode-configs/${encodeURIComponent(configName)}/set-default`,
      {},
      { params: { userId } }
    )
    return data
  },

  getDefaultOpenCodeConfig: async (userId = 'default'): Promise<OpenCodeConfig | null> => {
    try {
      const { data } = await axios.get(`${API_BASE_URL}/api/settings/opencode-configs/default`, {
        params: { userId },
      })
      return data
    } catch {
      return null
    }
  },

  /**
   * 커스텀 provider 등록(추가/갱신). 전용 엔드포인트를 탄다 —
   * 범용 PUT 은 기본 config 가 아직 없을 때 404 로 실패하고(초기 설치 상태),
   * config 의 provider 레코드를 쓰고 활성 파일·opencode 재시작까지 처리한다.
   */
  upsertProvider: async (
    provider: UpsertProviderRequest,
    configName = 'default',
  ): Promise<{ success: boolean; providerId: string; config: OpenCodeConfig }> => {
    const { data } = await axios.post(
      `${API_BASE_URL}/api/settings/opencode-configs/${encodeURIComponent(configName)}/providers`,
      provider,
    )
    return data
  },

  /** provider 제거. 커스텀은 config 레코드 삭제, 기본 제공분은 disabled_providers 로 숨긴다.
   *  mode: 'unregistered' = 레코드 삭제, 'disabled' = 기본 제공분 숨김. */
  removeProvider: async (
    providerId: string,
    configName = 'default',
  ): Promise<{ success: boolean; credentialsRemoved: boolean; mode?: 'unregistered' | 'disabled' }> => {
    const { data } = await axios.delete(
      `${API_BASE_URL}/api/settings/opencode-configs/${encodeURIComponent(configName)}/providers/${encodeURIComponent(providerId)}`,
    )
    return data
  },

  getCustomCommands: async (userId = 'default'): Promise<CustomCommand[]> => {
    const { data } = await axios.get(`${API_BASE_URL}/api/settings/custom-commands`, {
      params: { userId },
    })
    return data
  },

  createCustomCommand: async (
    command: CustomCommand,
    userId = 'default'
  ): Promise<CustomCommand> => {
    const { data } = await axios.post(`${API_BASE_URL}/api/settings/custom-commands`, command, {
      params: { userId },
    })
    return data
  },

  updateCustomCommand: async (
    name: string,
    command: CustomCommand,
    userId = 'default'
  ): Promise<CustomCommand> => {
    const { data } = await axios.put(
      `${API_BASE_URL}/api/settings/custom-commands/${encodeURIComponent(name)}`,
      command,
      { params: { userId } }
    )
    return data
  },

  deleteCustomCommand: async (name: string, userId = 'default'): Promise<boolean> => {
    await axios.delete(
      `${API_BASE_URL}/api/settings/custom-commands/${encodeURIComponent(name)}`,
      { params: { userId } }
    )
    return true
  },

  restartOpenCodeServer: async (): Promise<{ success: boolean; message: string }> => {
    const { data } = await axios.post(`${API_BASE_URL}/api/settings/opencode-restart`)
    return data
  },
}
