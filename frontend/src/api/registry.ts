import axios from 'axios'
import { API_BASE_URL } from '@/config'

export type RegistryType = 'command' | 'skill' | 'tool'
export type RegistryScope = 'global' | 'project'

export interface RegisterRequest {
  type: RegistryType
  scope: RegistryScope
  name: string
  description: string
  content: string
}

export interface RegisterResult {
  success: boolean
  type: RegistryType
  scope: RegistryScope
  name: string
  path: string
}

export const registryApi = {
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
}