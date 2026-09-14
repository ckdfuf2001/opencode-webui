import { API_BASE_URL } from '@/config'

export interface SystemInfo {
  version: string
  backend: {
    port: number
    host: string
    nodeVersion: string
    uptimeSec: number
    workspacePath: string
    reposPath: string
    configPath: string
  }
  opencode: {
    port: number
    healthy: boolean
  }
  timestamp: string
}

export async function getSystemInfo(): Promise<SystemInfo> {
  const res = await fetch(`${API_BASE_URL}/api/system/info`)
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    throw new Error(body?.error || `Failed to get system info (${res.status})`)
  }
  return res.json()
}
