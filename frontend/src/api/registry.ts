import axios from 'axios'
import { API_BASE_URL } from '@/config'

export type RegistryType = 'command' | 'skill' | 'tool' | 'agent'
export type RegistryScope = 'global' | 'project'
export type RegistryAgentMode = 'all' | 'subagent' | 'primary'

export interface RegisterRequest {
  type: RegistryType
  scope: RegistryScope
  name: string
  description: string
  content: string
  mode?: RegistryAgentMode
}

export interface RegisterResult {
  success: boolean
  type: RegistryType
  scope: RegistryScope
  name: string
  path: string
}

export interface RegistryEntry {
  name: string
  scope: RegistryScope
  path: string
  content: string
}

export const registryApi = {
  list: async (
    type: RegistryType,
    directory?: string
  ): Promise<RegistryEntry[]> => {
    const { data } = await axios.get(`${API_BASE_URL}/api/registry/${type}`, {
      params: directory ? { directory } : {},
    })
    return data
  },

  register: async (
    payload: RegisterRequest,
    directory?: string
  ): Promise<RegisterResult> => {
    const { data } = await axios.post(`${API_BASE_URL}/api/registry`, payload, {
      params: directory ? { directory } : {},
    })
    return data
  },

  unregister: async (
    type: RegistryType,
    scope: RegistryScope,
    name: string,
    directory?: string
  ): Promise<boolean> => {
    await axios.delete(
      `${API_BASE_URL}/api/registry/${type}/${scope}/${encodeURIComponent(name)}`,
      { params: directory ? { directory } : {} }
    )
    return true
  },

  reload: async (directory?: string): Promise<{ success: boolean; reloaded: number }> => {
    const { data } = await axios.post(`${API_BASE_URL}/api/registry/reload`, null, {
      params: directory ? { directory } : {},
    })
    return data
  },
}