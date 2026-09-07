import { Hono } from 'hono'
import type { Database } from 'bun:sqlite'
import * as db from '../db/queries'
import * as repoService from '../services/repo'
import * as gitOperations from '../services/git-operations'
import { SettingsService } from '../services/settings'
import { applyRepoTracking, applyRepoTrackingForAllRepos } from '../services/repo-tracking'
import { writeFileContent } from '../services/file-operations'
import { opencodeServerManager } from '../services/opencode-single-server'
import { releaseAgentBrowserForDirectory } from '../services/default-mcp'
import { ensureServerAuth } from '../services/opencode-auth'
import { logger } from '../utils/logger'
import { withTransactionAsync } from '../db/transactions'
import { getOpenCodeConfigFilePath, getReposPath } from '@opencode-webui/shared'
import path from 'path'

export function createRepoRoutes(database: Database) {
  const app = new Hono()
  
  app.post('/', async (c) => {
    try {
      const body = await c.req.json()
      const { repoUrl, localPath, branch, openCodeConfigName, useWorktree } = body
      
      if (!repoUrl && !localPath) {
        return c.json({ error: 'Either repoUrl or localPath is required' }, 400)
      }
      
      let repo
      if (localPath) {
        repo = await repoService.initLocalRepo(
          database,
          localPath,
          branch
        )
      } else {
        repo = await repoService.cloneRepo(
          database,
          repoUrl!,
          branch,
          useWorktree
        )
      }
      
      if (openCodeConfigName) {
        const settingsService = new SettingsService(database)
        const configContent = settingsService.getOpenCodeConfigContent(openCodeConfigName)

        if (configContent) {
          const openCodeConfigPath = getOpenCodeConfigFilePath()
          await writeFileContent(openCodeConfigPath, configContent)
          db.updateRepoConfigName(database, repo.id, openCodeConfigName)
          logger.info(`Applied config '${openCodeConfigName}' to: ${openCodeConfigPath}`)
        }
      }

      try {
        const { preferences } = new SettingsService(database).getSettings()
        const fullPath = path.resolve(getReposPath(), repo.localPath)
        await applyRepoTracking(fullPath, preferences.repoTrackPaths ?? [])
      } catch (trackingError) {
        logger.warn(`Failed to apply repo tracking to ${repo.localPath}:`, trackingError)
      }

      return c.json(repo)
    } catch (error: any) {
      logger.error('Failed to create repo:', error)
      return c.json({ error: error.message }, 500)
    }
  })
  
  app.post('/tracking/apply-all', async (c) => {
    try {
      const applied = await applyRepoTrackingForAllRepos(database)
      logger.info(`Manually re-applied repo tracking to ${applied} repos`)
      return c.json({ success: true, applied })
    } catch (error: any) {
      logger.error('Failed to apply repo tracking to all repos:', error)
      return c.json({ error: error.message || 'Failed to apply repo tracking' }, 500)
    }
  })

  app.get('/', async (c) => {
    try {
      const repos = db.listRepos(database)
      const reposWithCurrentBranch = await Promise.all(
        repos.map(async (repo) => {
          const currentBranch = await repoService.getCurrentBranch(repo)
          return { ...repo, currentBranch }
        })
      )
      return c.json(reposWithCurrentBranch)
    } catch (error: any) {
      logger.error('Failed to list repos:', error)
      return c.json({ error: error.message }, 500)
    }
  })
  
  app.get('/:id', async (c) => {
    try {
      const id = parseInt(c.req.param('id'))
      const repo = db.getRepoById(database, id)
      
      if (!repo) {
        return c.json({ error: 'Repo not found' }, 404)
      }
      
      const currentBranch = await repoService.getCurrentBranch(repo)
      
      return c.json({ ...repo, currentBranch })
    } catch (error: any) {
      logger.error('Failed to get repo:', error)
      return c.json({ error: error.message }, 500)
    }
  })
  
  app.delete('/:id', async (c) => {
    const startedAt = Date.now()
    try {
      const id = parseInt(c.req.param('id'))
      const repo = db.getRepoById(database, id)

      if (!repo) {
        return c.json({ error: 'Repo not found' }, 404)
      }

      const repoDir = path.resolve(getReposPath(), path.basename(repo.localPath))
      const headers = ensureServerAuth({ 'Content-Type': 'application/json' })

      // Stop any opencode sessions running inside this repo so they release their file handles before the directory is removed
      try {
        await opencodeServerManager.ensureRunning()
        const base = opencodeServerManager.getUrl()
        const directoryParam = encodeURIComponent(repoDir)
        const sessionRes = await fetch(`${base}/session?directory=${directoryParam}`, {
          headers,
          signal: AbortSignal.timeout(10_000)
        })
        if (sessionRes.ok) {
          const sessions = await sessionRes.json() as Array<{ id: string }>
          await Promise.allSettled(sessions.map((session) =>
            fetch(`${base}/session/${session.id}?directory=${directoryParam}`, {
              method: 'DELETE',
              headers,
              signal: AbortSignal.timeout(5_000)
            }).then((res) => {
              if (!res.ok) logger.warn(`Failed to stop opencode session ${session.id}: HTTP ${res.status}`)
            }).catch((error) => logger.warn(`Failed to stop opencode session ${session.id}:`, error))
          ))
        }
      } catch (error) {
        logger.warn('Failed to stop opencode sessions for repo:', error)
      }

      const withIndexParam = c.req.query('withIndex')
      const withIndex = withIndexParam == null ? true : withIndexParam !== 'false' && withIndexParam !== '0'
      // DB 삭제는 즉시 수행 (빠른 응답), 파일 삭제는 백그라운드로 이동
      await withTransactionAsync(database, async (tx) => {
        db.deleteRepoCascade(tx, id, { withIndex })
      })
      logger.info(`Repo DB deleted in ${Date.now() - startedAt}ms (repo id ${id}), files will be removed in background`)
      const response = c.json({ success: true })
      // 백그라운드 파일 삭제 (Windows 핸들 해제 재시도 포함, 응답 후 비동기 실행)
      setImmediate(async () => {
        try {
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              await repoService.deleteRepoFiles(database, id)
              logger.info(`Repo files deleted in background (repo id ${id}, attempt ${attempt})`)
              break
            } catch (error) {
              logger.warn(`Background repo file deletion attempt ${attempt}/3 failed:`, error)
              releaseAgentBrowserForDirectory(repoDir)
              await new Promise((resolve) => setTimeout(resolve, 600 * attempt))
            }
          }
        } catch (e) {
          logger.error('Background repo file deletion failed:', e)
        }
      })
      return response
    } catch (error: any) {
      logger.error('Failed to delete repo:', error)
      return c.json({ error: error.message }, 500)
    }
  })

  app.post('/:id/clone', async (c) => {
    try {
      const sourceId = parseInt(c.req.param('id'))
      const body = await c.req.json().catch(() => ({})) as { newLocalPath?: string; newName?: string }
      const rawName = (body.newLocalPath || body.newName || '').trim()
      if (!rawName) return c.json({ error: 'newLocalPath is required' }, 400)
      const newLocalPath = rawName.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/\/+$/, '')
      if (!newLocalPath) return c.json({ error: 'invalid newLocalPath' }, 400)
      const sourceRepo = db.getRepoById(database, sourceId)
      if (!sourceRepo) return c.json({ error: 'Source repo not found' }, 404)
      if (db.getRepoByLocalPath(database, newLocalPath)) return c.json({ error: 'Target path already exists' }, 409)
      const sourcePath = path.resolve(getReposPath(), path.basename(sourceRepo.localPath))
      const destPath = path.resolve(getReposPath(), newLocalPath)
      const fs = await import('fs/promises')
      try { await fs.access(destPath); return c.json({ error: 'Target directory already exists on disk' }, 409) } catch {}
      await fs.mkdir(destPath, { recursive: true })
      // git-tracked only: md, scripts, .opencode, opencode.json
      let tracked: string[] = []
      try {
        const out = await executeCommand(['git', '-C', sourcePath, 'ls-files'], { silent: true })
        tracked = out.split('\n').map(s => s.trim()).filter(Boolean)
      } catch {
        tracked = []
      }
      const allowed = tracked.filter(p => {
        if (p.includes('chat_uploads')) return false
        if (p.endsWith('.md')) return true
        if (p.startsWith('scripts/')) return true
        if (p.startsWith('.opencode/')) return true
        if (p === 'opencode.json' || p === 'opencode.jsonc') return true
        if (p.startsWith('opencode/')) return true
        return false
      })
      for (const rel of allowed) {
        try {
          const srcFile = path.join(sourcePath, rel)
          const destFile = path.join(destPath, rel)
          await fs.mkdir(path.dirname(destFile), { recursive: true })
          await fs.copyFile(srcFile, destFile)
        } catch (e) { logger.warn(`clone copy skip ${rel}:`, e) }
      }
      // also copy opencode folder if exists but not tracked? ensure at least .opencode if present
      // copy permission rules and skill setting
      const newRepo = db.createRepo(database, {
        localPath: newLocalPath,
        branch: sourceRepo.branch,
        defaultBranch: sourceRepo.defaultBranch || 'main',
        cloneStatus: 'ready',
        clonedAt: Date.now(),
        isLocal: true,
      })
      try {
        const { listPermissionRules, createPermissionRule } = await import('../db/permission-rule-queries')
        const rules = listPermissionRules(database, sourceId)
        for (const r of rules) {
          try { createPermissionRule(database, { repoId: newRepo.id, permission: r.permission, pattern: r.pattern }) } catch {}
        }
      } catch {}
      try {
        const skill = db.getSkillAutoUpdate(database, sourceId)
        if (skill) db.setSkillAutoUpdate(database, newRepo.id, skill)
      } catch {}
      try {
        const { writeRepoOpenCodeConfig } = await import('../services/default-mcp')
        writeRepoOpenCodeConfig(newLocalPath)
      } catch {}
      const currentBranch = await repoService.getCurrentBranch(newRepo).catch(() => null)
      return c.json({ ...newRepo, currentBranch })
    } catch (error: any) {
      logger.error('Failed to clone repo:', error)
      return c.json({ error: error.message }, 500)
    }
  })

  app.get('/:id/export', async (c) => {
    try {
      const id = parseInt(c.req.param('id'))
      const repo = db.getRepoById(database, id)
      if (!repo) return c.json({ error: 'Repo not found' }, 404)
      const sourcePath = path.resolve(getReposPath(), path.basename(repo.localPath))
      let tracked: string[] = []
      try {
        const out = await executeCommand(['git', '-C', sourcePath, 'ls-files'], { silent: true })
        tracked = out.split('\n').map(s => s.trim()).filter(Boolean)
      } catch { tracked = [] }
      const allowed = tracked.filter(p => {
        if (p.includes('chat_uploads')) return false
        if (p.endsWith('.md')) return true
        if (p.startsWith('scripts/')) return true
        if (p.startsWith('.opencode/')) return true
        if (p === 'opencode.json' || p === 'opencode.jsonc') return true
        if (p.startsWith('opencode/')) return true
        return false
      })
      const fs = await import('fs/promises')
      const files: Record<string, string> = {}
      for (const rel of allowed) {
        try {
          const content = await fs.readFile(path.join(sourcePath, rel), 'utf-8')
          if (content.length < 500000) files[rel] = content
        } catch {}
      }
      const { listPermissionRules } = await import('../db/permission-rule-queries')
      const rules = listPermissionRules(database, id)
      const skillEnabled = db.getSkillAutoUpdate(database, id)
      return c.json({
        version: 1,
        exportedAt: Date.now(),
        repo: { repoUrl: repo.repoUrl, localPath: repo.localPath, branch: repo.branch, defaultBranch: repo.defaultBranch, isLocal: repo.isLocal },
        permissionRules: rules.map(r => ({ permission: r.permission, pattern: r.pattern })),
        skillAutoUpdate: skillEnabled,
        files,
      })
    } catch (error: any) {
      logger.error('Failed to export repo:', error)
      return c.json({ error: error.message }, 500)
    }
  })

  app.post('/import', async (c) => {
    try {
      const body = await c.req.json() as { newLocalPath?: string; data?: any; exportData?: any }
      const data = body.data || body.exportData || body
      const rawName = (body.newLocalPath || data.repo?.localPath || '').trim()
      const newLocalPath = rawName ? rawName.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/\/+$/, '') : `imported-${Date.now()}`
      if (db.getRepoByLocalPath(database, newLocalPath)) return c.json({ error: 'Target path already exists' }, 409)
      const destPath = path.resolve(getReposPath(), newLocalPath)
      const fs = await import('fs/promises')
      try { await fs.access(destPath); return c.json({ error: 'Target directory already exists on disk' }, 409) } catch {}
      await fs.mkdir(destPath, { recursive: true })
      // write files
      const files = (data.files || {}) as Record<string, string>
      for (const [rel, content] of Object.entries(files)) {
        if (typeof content !== 'string') continue
        if (rel.includes('..')) continue
        try {
          const destFile = path.join(destPath, rel)
          await fs.mkdir(path.dirname(destFile), { recursive: true })
          await fs.writeFile(destFile, content, 'utf-8')
        } catch {}
      }
      const repoUrl = data.repo?.repoUrl || null
      const branch = data.repo?.branch || undefined
      const defaultBranch = data.repo?.defaultBranch || 'main'
      const isLocal = true
      // init git if not already a repo and source was git
      try { await executeCommand(['git', '-C', destPath, 'rev-parse', '--git-dir'], { silent: true }) } catch {
        try { await executeCommand(['git', 'init'], destPath) } catch {}
      }
      const newRepo = db.createRepo(database, {
        repoUrl: repoUrl || undefined,
        localPath: newLocalPath,
        branch,
        defaultBranch,
        cloneStatus: 'ready',
        clonedAt: Date.now(),
        isLocal,
      })
      // restore permission rules
      try {
        const { createPermissionRule } = await import('../db/permission-rule-queries')
        for (const r of (data.permissionRules || [])) {
          try { createPermissionRule(database, { repoId: newRepo.id, permission: r.permission, pattern: r.pattern }) } catch {}
        }
      } catch {}
      try { if (typeof data.skillAutoUpdate === 'boolean') db.setSkillAutoUpdate(database, newRepo.id, data.skillAutoUpdate) } catch {}
      try {
        const { writeRepoOpenCodeConfig } = await import('../services/default-mcp')
        writeRepoOpenCodeConfig(newLocalPath)
      } catch {}
      const currentBranch = await repoService.getCurrentBranch(newRepo).catch(() => null)
      return c.json({ ...newRepo, currentBranch })
    } catch (error: any) {
      logger.error('Failed to import repo:', error)
      return c.json({ error: error.message }, 500)
    }
  })
  
  app.post('/:id/pull', async (c) => {
    try {
      const id = parseInt(c.req.param('id'))
      await repoService.pullRepo(database, id)
      
      const repo = db.getRepoById(database, id)
      return c.json(repo)
    } catch (error: any) {
      logger.error('Failed to pull repo:', error)
      return c.json({ error: error.message }, 500)
    }
  })

  app.post('/:id/config/switch', async (c) => {
    try {
      const id = parseInt(c.req.param('id'))
      const repo = db.getRepoById(database, id)
      
      if (!repo) {
        return c.json({ error: 'Repo not found' }, 404)
      }
      
      const body = await c.req.json()
      const { configName } = body
      
      if (!configName) {
        return c.json({ error: 'configName is required' }, 400)
      }
      
      const settingsService = new SettingsService(database)
      const configContent = settingsService.getOpenCodeConfigContent(configName)
      
      if (!configContent) {
        return c.json({ error: `Config '${configName}' not found` }, 404)
      }
      
      const openCodeConfigPath = getOpenCodeConfigFilePath()
      
      await writeFileContent(openCodeConfigPath, configContent)
      
      db.updateRepoConfigName(database, id, configName)
      
      logger.info(`Switched config for repo ${id} to '${configName}'`)
      logger.info(`Updated OpenCode config: ${openCodeConfigPath}`)
      
      logger.info('Restarting OpenCode server due to workspace config change')
      await opencodeServerManager.stop()
      await opencodeServerManager.start()
      
      const updatedRepo = db.getRepoById(database, id)
      return c.json(updatedRepo)
    } catch (error: any) {
      logger.error('Failed to switch repo config:', error)
      return c.json({ error: error.message }, 500)
    }
  })

  app.post('/:id/branch/switch', async (c) => {
    try {
      const id = parseInt(c.req.param('id'))
      const repo = db.getRepoById(database, id)
      
      if (!repo) {
        return c.json({ error: 'Repo not found' }, 404)
      }
      
      const body = await c.req.json()
      const { branch } = body
      
      if (!branch) {
        return c.json({ error: 'branch is required' }, 400)
      }
      
      await repoService.switchBranch(database, id, branch)
      
      const updatedRepo = db.getRepoById(database, id)
      const currentBranch = await repoService.getCurrentBranch(updatedRepo!)
      
      return c.json({ ...updatedRepo, currentBranch })
    } catch (error: any) {
      logger.error('Failed to switch branch:', error)
      return c.json({ error: error.message }, 500)
    }
  })

  app.get('/:id/branches', async (c) => {
    try {
      const id = parseInt(c.req.param('id'))
      const repo = db.getRepoById(database, id)
      
      if (!repo) {
        return c.json({ error: 'Repo not found' }, 404)
      }
      
      const branches = await repoService.listBranches(repo)
      
      return c.json(branches)
    } catch (error: any) {
      logger.error('Failed to list branches:', error)
      return c.json({ error: error.message }, 500)
    }
  })

  app.get('/:id/git/status', async (c) => {
    try {
      const id = parseInt(c.req.param('id'))
      const repo = db.getRepoById(database, id)
      
      if (!repo) {
        return c.json({ error: 'Repo not found' }, 404)
      }
      
      const repoPath = path.resolve(getReposPath(), repo.localPath)
      const status = await gitOperations.getGitStatus(repoPath)
      
      return c.json(status)
    } catch (error: any) {
      logger.error('Failed to get git status:', error)
      return c.json({ error: error.message }, 500)
    }
  })

  app.get('/:id/git/diff', async (c) => {
    try {
      const id = parseInt(c.req.param('id'))
      const filePath = c.req.query('path')
      
      if (!filePath) {
        return c.json({ error: 'path query parameter is required' }, 400)
      }
      
      const repo = db.getRepoById(database, id)
      
      if (!repo) {
        return c.json({ error: 'Repo not found' }, 404)
      }
      
      const repoPath = path.resolve(getReposPath(), repo.localPath)
      const diff = await gitOperations.getFileDiff(repoPath, filePath)
      
      return c.json(diff)
    } catch (error: any) {
      logger.error('Failed to get file diff:', error)
      return c.json({ error: error.message }, 500)
    }
  })

  app.get('/:id/skill-auto-update', async (c) => {
    try {
      const id = parseInt(c.req.param('id'))
      const repo = db.getRepoById(database, id)
      if (!repo) return c.json({ error: 'Repo not found' }, 404)
      const enabled = db.getSkillAutoUpdate(database, id)
      return c.json({ enabled })
    } catch (error: any) {
      logger.error('Failed to get skill auto update:', error)
      return c.json({ error: error.message }, 500)
    }
  })

  app.patch('/:id/skill-auto-update', async (c) => {
    try {
      const id = parseInt(c.req.param('id'))
      const repo = db.getRepoById(database, id)
      if (!repo) return c.json({ error: 'Repo not found' }, 404)
      const body = await c.req.json() as { enabled?: boolean }
      if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled boolean required' }, 400)
      db.setSkillAutoUpdate(database, id, body.enabled)
      return c.json({ enabled: body.enabled })
    } catch (error: any) {
      logger.error('Failed to set skill auto update:', error)
      return c.json({ error: error.message }, 500)
    }
  })
  
  return app
}
