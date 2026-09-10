import { API_BASE_URL } from '@/config'

export interface HtmlManagedPage {
  name: string
  kind: 'file' | 'code'
  path: string
  html: string
  updatedAt: number
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}/api/html-view${path}`, init)
  if (!response.ok) {
    let message = `Request failed (${response.status})`
    try {
      const body = await response.json()
      if (body?.error) message = body.error
    } catch {
      // ignore
    }
    throw new Error(message)
  }
  return response.json() as Promise<T>
}

export function listHtmlPages(): Promise<HtmlManagedPage[]> {
  return request<HtmlManagedPage[]>('/pages')
}

export function upsertHtmlPage(input: { name: string; kind: 'file' | 'code'; path?: string; html?: string }): Promise<HtmlManagedPage> {
  return request<HtmlManagedPage>('/pages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
}

export async function deleteHtmlPage(name: string): Promise<void> {
  await request<{ success: boolean }>(`/pages?name=${encodeURIComponent(name)}`, { method: 'DELETE' })
}

export async function renameHtmlPage(oldName: string, newName: string, page: HtmlManagedPage): Promise<HtmlManagedPage> {
  const created = await upsertHtmlPage({ name: newName, kind: page.kind, path: page.path, html: page.html })
  try {
    await deleteHtmlPage(oldName)
  } catch {
    // 이름이 같았거나 이미 없으면 무시
  }
  return created
}
