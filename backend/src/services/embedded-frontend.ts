import { readFile } from 'fs/promises'
import { logger } from '../utils/logger'

interface Asset {
  body: Buffer
  contentType: string
  immutable: boolean
}

const cache = new Map<string, Asset>()
let loadPromise: Promise<void> | null = null

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

function mimeFor(route: string): string {
  const dot = route.lastIndexOf('.')
  const ext = dot === -1 ? '' : route.slice(dot).toLowerCase()
  return MIME_TYPES[ext] ?? 'application/octet-stream'
}

function normalizeRoute(route: string): string {
  if (route === '/' || route === '') return '/index.html'
  return route.startsWith('/') ? route : `/${route}`
}

async function ensureLoaded(): Promise<void> {
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    try {
      // Present in compiled releases (packaging generates it before compile).
      // In dev it is an empty placeholder or may fail to resolve - both fall
      // back to serving frontend/dist from disk.
      const mod = await import('../generated/frontend-embed.generated')
      for (const entry of mod.embeddedFiles) {
        try {
          const body = await readFile(entry.path)
          const route = normalizeRoute(entry.route)
          cache.set(route, {
            body,
            contentType: mimeFor(route),
            immutable: route.startsWith('/assets/'),
          })
        } catch (error) {
          logger.warn(`Embedded asset unreadable (${entry.route}); skipping`, error)
        }
      }
      logger.info(`Embedded frontend assets loaded: ${cache.size} file(s)`)
    } catch {
      logger.info('No embedded frontend assets; serving from disk fallback')
    }
  })()
  return loadPromise
}

export async function getEmbeddedAsset(route: string): Promise<Asset | null> {
  await ensureLoaded()
  return cache.get(normalizeRoute(route)) ?? null
}

export async function hasEmbeddedAssets(): Promise<boolean> {
  await ensureLoaded()
  return cache.size > 0
}
