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
          for (const session of sessions) {
            await fetch(`${base}/session/${session.id}?directory=${directoryParam}`, {
              method: 'DELETE',
              headers,
              signal: AbortSignal.timeout(10_000)
            }).catch((error) => logger.warn(`Failed to stop opencode session ${session.id}:`, error))
          }
        }
      } catch (error) {
        logger.warn('Failed to stop opencode sessions for repo:', error)
      }

      // Remove files OUTSIDE the DB transaction (fs deletion is slow and must not hold the SQLite connection).
      // On Windows the dir is pinned by processes whose cwd/open handles point
      // into it (opencode sessions, agent-browser daemon + Chrome, doc reader).
      // Release those and retry a few times before giving up.
      let deleteErr: unknown = null
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await repoService.deleteRepoFiles(database, id)
          deleteErr = null
          break
        } catch (error) {
          deleteErr = error
          logger.warn(`Repo file deletion attempt ${attempt}/3 failed, releasing handles and retrying:`, error)
          releaseAgentBrowserForDirectory(repoDir)
          await opencodeServerManager.restart().catch((restartError) =>
            logger.error('Failed to restart OpenCode server after repo delete:', restartError)
          )
          await new Promise((resolve) => setTimeout(resolve, 800))
        }
      }
      if (deleteErr) {
        throw deleteErr
      }

      // Delete the DB row inside a short, serialized transaction
      await withTransactionAsync(database, async (tx) => {
        db.deleteRepo(tx, id)
      })

      return c.json({ success: true })
    } catch (error: any) {
      logger.error('Failed to delete repo:', error)
      return c.json({ error: error.message }, 500)
    } finally {
      await opencodeServerManager.start().catch((startError) => logger.error('Failed to start OpenCode server:', startError))
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
  
  return app
}
