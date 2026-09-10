import { API_BASE_URL } from '@/config'

const BROWSER_VIEWABLE_EXTENSIONS = ['.html', '.htm', '.txt', '.log', '.json', '.md', '.markdown', '.csv', '.xml', '.yaml', '.yml']

export function isBrowserViewable(path: string): boolean {
  const lower = path.toLowerCase().split('?')[0]
  return BROWSER_VIEWABLE_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

export function htmlViewUrl(path: string, title?: string): string {
  const base = `${API_BASE_URL}/api/html-view?path=${encodeURIComponent(path)}`
  return title?.trim() ? `${base}&title=${encodeURIComponent(title.trim())}` : base
}

export function openHtmlInNewTab(path: string, title?: string): void {
  window.open(htmlViewUrl(path, title), '_blank', 'noopener')
}

function withTitle(html: string, title: string): string {
  const tag = `<title>${title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</title>`
  if (/<title[^>]*>[\s\S]*?<\/title>/i.test(html)) {
    return html.replace(/<title[^>]*>[\s\S]*?<\/title>/i, tag)
  }
  const match = html.match(/<head[^>]*>/i)
  if (match && match.index !== undefined) {
    const insertAt = match.index + match[0].length
    return html.slice(0, insertAt) + tag + html.slice(insertAt)
  }
  return `<head>${tag}</head>` + html
}

export function codeDocument(html: string, title?: string): string {
  return title?.trim() ? withTitle(html, title.trim()) : html
}

export function openCodeInNewTab(html: string, title?: string): void {
  const url = URL.createObjectURL(new Blob([codeDocument(html, title)], { type: 'text/html' }))
  window.open(url, '_blank', 'noopener')
}
