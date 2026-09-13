import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// iPhone 흰화면 디버깅용 — 에러를 화면에 직접 표시 (Mac 없이도 원인 확인)
function showMobileError(msg: string, src?: string, line?: number, col?: number) {
  try {
    let el = document.getElementById('mobile-error-overlay')
    if (!el) {
      el = document.createElement('div')
      el.id = 'mobile-error-overlay'
      el.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#fff;color:#d00;padding:16px;font:12px/1.4 monospace;overflow:auto;white-space:pre-wrap;word-break:break-all'
      document.body.appendChild(el)
    }
    el.textContent += `\n[${new Date().toISOString().slice(11,19)}] ${msg}${src ? `\n  at ${src}:${line ?? ''}:${col ?? ''}` : ''}`
  } catch {}
}
try {
  window.addEventListener('error', (e) => showMobileError(e.message || String(e.error), (e as ErrorEvent).filename, (e as ErrorEvent).lineno, (e as ErrorEvent).colno))
  window.addEventListener('unhandledrejection', (e) => showMobileError(`Unhandled: ${String((e as PromiseRejectionEvent).reason)}`))
} catch {}

try {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
} catch (e) {
  showMobileError(`Render failed: ${String(e)}`)
  throw e
}
