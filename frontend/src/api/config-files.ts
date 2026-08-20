import axios from 'axios'
import { API_BASE_URL } from '@/config'

export type ConfigFileScope = 'global' | 'project'
export type ConfigFileName = 'AGENTS.md' | 'opencode.json'

export interface ConfigFileInfo {
  name: ConfigFileName
  scope: ConfigFileScope
  path: string
  exists: boolean
  content: string | null
}

export interface ConfigFileListResponse {
  files: ConfigFileInfo[]
}

export const configFilesApi = {
  list: async (directory?: string): Promise<ConfigFileInfo[]> => {
    const { data } = await axios.get<ConfigFileListResponse>(`${API_BASE_URL}/api/config-files`, {
      params: directory ? { directory } : undefined,
    })
    return data.files
  },

  write: async (
    scope: ConfigFileScope,
    name: ConfigFileName,
    content: string,
    directory?: string
  ): Promise<{ success: boolean; path: string }> => {
    const { data } = await axios.put(`${API_BASE_URL}/api/config-files`, {
      scope,
      name,
      content,
      directory,
    })
    return data
  },

  remove: async (scope: ConfigFileScope, name: ConfigFileName, directory?: string): Promise<boolean> => {
    await axios.delete(`${API_BASE_URL}/api/config-files`, {
      params: { scope, name, ...(directory ? { directory } : {}) },
    })
    return true
  },
}