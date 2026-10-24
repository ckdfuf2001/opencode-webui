import { Hono } from 'hono'
import * as fileService from '../services/files'
import { SettingsService } from '../services/settings'
import type { Database } from 'bun:sqlite'
import { logger } from '../utils/logger'
import { createHash } from 'node:crypto'

export function createFileRoutes(database: Database) {
  const app = new Hono()

  const decodePath = (c: { req: { path: string } }) =>
    c.req.path.replace(/^\/api\/files\//, '').replace(/%2F/gi, '/').split('/').map((seg) => {
      try {
        return decodeURIComponent(seg)
      } catch {
        return seg
      }
    }).join('/')

  app.get('/search', async (c) => {
    try {
      const basePath = c.req.query('path') || '.'
      const query = c.req.query('query') || ''
      if (c.req.query('details') === 'true') {
        const results = await fileService.searchFiles(basePath, query, { details: true })
        return c.json(results)
      }
      const results = await fileService.searchFiles(basePath, query)
      return c.json(results)
    } catch (error: any) {
      logger.error('Failed to search files:', error)
      return c.json({ error: error.message || 'Failed to search files' }, error.statusCode || 500)
    }
  })

  app.get('/stat', async (c) => {
    try {
      const userPath = c.req.query('path') || ''
      if (!userPath) return c.json({ error: 'Missing path query parameter' }, 400)
      const result = await fileService.getFileStat(userPath)
      return c.json(result)
    } catch (error: any) {
      logger.error('Failed to stat file:', error)
      return c.json({ error: error.message || 'Failed to stat file' }, error.statusCode || 500)
    }
  })

  app.get('/*', async (c) => {
    try {
      const userPath = decodePath(c)
      const download = c.req.query('download') === 'true'
      const raw = c.req.query('raw') === 'true'
      const startLineParam = c.req.query('startLine')
      const endLineParam = c.req.query('endLine')
      
      if (startLineParam !== undefined && endLineParam !== undefined) {
        const startLine = parseInt(startLineParam, 10)
        const endLine = parseInt(endLineParam, 10)
        
        if (isNaN(startLine) || isNaN(endLine) || startLine < 0 || endLine < startLine) {
          return c.json({ error: 'Invalid line range parameters' }, 400)
        }
        
        const result = await fileService.getFileRange(userPath, startLine, endLine)
        return c.json(result)
      }
      
      const result = await fileService.getFile(userPath)
      
      if (raw && !result.isDirectory) {
        const content = await fileService.getRawFileContent(userPath)
        // X1c(P0): 단독 저장(덮어쓰기)의 잠금용 ETag. 클라이언트는 이 값을 If-Match 로
        // 되돌려 보낸다 → 디스크가 그 사이에 바뀌었으면 서버가 409 로 거부한다.
        const etag = `"${createHash('sha256').update(content).digest('hex')}"`
        return new Response(content, {
          headers: {
            'Content-Type': result.mimeType || 'application/octet-stream',
            'Content-Length': result.size.toString(),
            ETag: etag,
            // M11: 파일 본문은 캐시하지 않는다.
            // 저장 직후 뷰어가 리마운트되면 브라우저가 **저장 이전 바이트**(캐시)를 다시 쓰면
            // 구 내용이 자동 저장으로 디스크를 덮어써 편집이 조용히 사라진다(E2/E2b 실패 원인).
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'Pragma': 'no-cache',
          }
        })
      }
      
      if (download && !result.isDirectory) {
        const content = await fileService.getRawFileContent(userPath)
        const asciiFallback = result.name.replace(/[^\x20-\x7e]/g, '_') || 'file'
        return new Response(content, {
          headers: {
            'Content-Type': result.mimeType || 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(result.name)}`,
            'Content-Length': content.length.toString(),
          }
        })
      }
      
      return c.json(result, 200, {
        // M11: 파일 본문 JSON 도 캐시하지 않는다(저장 직후 재조회가 구 내용을 받지 않게).
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        Pragma: 'no-cache',
      })
    } catch (error: any) {
      logger.error('Failed to get file:', error)
      return c.json({ error: error.message || 'Failed to get file' }, error.statusCode || 500)
    }
  })

  app.post('/*', async (c) => {
    try {
      const path = decodePath(c)
      // X1c(P0): 단독 저장의 잠금. 클라이언트가 보낸 If-Match 가 지금 디스크와 다르면
      // 409 로 거부한다(폰 http 처럼 해시를 못 계산하는 환경에서도 안전하다).
      // If-Match 가 없으면 덮어쓴다(기존 경로 — PPT 등 방을 거치지 않는 다른 클라이언트).
      const ifMatch = c.req.header('If-Match')
      if (ifMatch && ifMatch !== '*') {
        const stat = await fileService.getFileStat(path)
        if (stat.exists && !stat.isDirectory) {
          const content = await fileService.getRawFileContent(path)
          const etag = `"${createHash('sha256').update(content).digest('hex')}"`
          if (etag !== ifMatch) {
            return c.json(
              {
                error: 'File changed on disk since it was loaded (download your copy)',
                code: 'conflict_external',
                currentHash: etag.replace(/"/g, ''),
              },
              409,
            )
          }
        }
      }
      const body = await c.req.parseBody()

      const file = body.file as File
      if (!file) {
        return c.json({ error: 'No file provided' }, 400)
      }

      // 업로드 차단 확장자는 사용자 설정에서 읽는다 (userId 쿼리 지원, 기본 default).
      // 설정 조회 실패 시 서비스 기본값으로 폴백한다.
      let blocked: unknown
      try {
        const userId = c.req.query('userId') || 'default'
        blocked = new SettingsService(database).getSettings(userId).preferences.blockedUploadExtensions
      } catch {
        blocked = undefined
      }
      const result = await fileService.uploadFile(path, file, blocked, {
        overwrite: c.req.query('overwrite') === '1',
      })
      return c.json(result)
    } catch (error: any) {
      logger.error('Failed to upload file:', error)
      return c.json({ error: error.message }, error.statusCode || 500)
    }
  })

  app.put('/*', async (c) => {
    try {
      const path = decodePath(c)
      const body = await c.req.json()
      
      const result = await fileService.createFileOrFolder(path, body)
      return c.json(result)
    } catch (error: any) {
      logger.error('Failed to create file/folder:', error)
      return c.json({ error: error.message }, error.statusCode || 500)
    }
  })

  app.delete('/*', async (c) => {
    try {
      const path = decodePath(c)
      
      await fileService.deleteFileOrFolder(path)
      return c.json({ success: true })
    } catch (error: any) {
      logger.error('Failed to delete file/folder:', error)
      return c.json({ error: error.message }, error.statusCode || 500)
    }
  })

  app.patch('/*', async (c) => {
    try {
      const path = decodePath(c)
      const body = await c.req.json()
      
      if (body.patches && Array.isArray(body.patches)) {
        const result = await fileService.applyFilePatches(path, body.patches)
        return c.json(result)
      }
      
      const result = await fileService.renameOrMoveFile(path, body)
      return c.json(result)
    } catch (error: any) {
      logger.error('Failed to patch file:', error)
      return c.json({ error: error.message }, error.statusCode || 500)
    }
  })

  return app
}