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
import { executeCommand } from '../utils/process'
import * as scheduleQueries from '../db/schedule-queries'
import * as permissionRuleQueries from '../db/permission-rule-queries'
import path from 'path'

const REPO_EXPORT_VERSION = 2
const EXPORT_MAX_FILE_BYTES = 500000
const EXPORT_MAX_FILES = 2000
const INDEX_MAX_ROWS = 5000

function normalizeRel(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').trim()
}

function isExportableRel(rel: string): boolean {
  const p = normalizeRel(rel)
  if (!p || p.includes('..')) return false
  if (p.includes('chat_uploads')) return false
  if (p.startsWith('.git/') || p === '.git') return false
  if (p.startsWith('node_modules/')) return false
  if (p.startsWith('.trash-')) return false
  if (p.startsWith('dist/') || p.startsWith('build/') || p.startsWith('.next/')) return false
  // registry / 설정 계열: .opencode 전체 + 레포 루트 단복수 디렉토리 + opencode.json
  if (p.startsWith('.opencode/')) return true
  if (p === 'opencode.json' || p === 'opencode.jsonc') return true
  if (p.startsWith('opencode/')) return true
  if (p.startsWith('scripts/')) return true
  if (p.startsWith('commands/') || p.startsWith('command/')) return true
  if (p.startsWith('skills/') || p.startsWith('skill/')) return true
  if (p.startsWith('agents/') || p.startsWith('agent/')) return true
  if (p.startsWith('plugins/') || p.startsWith('plugin/')) return true
  if (p.startsWith('tools/') || p.startsWith('tool/')) return true
  if (p.startsWith('.agents/') || p.startsWith('.claude/')) return true
  // 문서 계열은 전부 포함 (AGENTS.md, SKILL.md, README 등)
  if (p.endsWith('.md')) return true
  if (p.endsWith('.mdc')) return true
  return false
}

async function listGitTrackedFiles(sourcePath: string): Promise<string[]> {
  try {
    const out = await executeCommand(['git', '-C', sourcePath, 'ls-files'], { silent: true })
    return out.split('\n').map((s) => normalizeRel(s)).filter(Boolean)
  } catch {
    return []
  }
}

async function listAllowedFilesFs(root: string): Promise<string[]> {
  const fs = await import('fs/promises')
  const out: string[] = []
  const stack = ['.']
  const skipDir = new Set(['.git', 'node_modules', 'dist', 'build', '.next'])
  while (stack.length > 0 && out.length < EXPORT_MAX_FILES) {
    const cur = stack.pop()!
    const abs = cur === '.' ? root : path.join(root, cur)
    let entries: Array<{ name: string; isDirectory(): boolean }> = []
    try {
      entries = (await fs.readdir(abs, { withFileTypes: true })) as Array<{ name: string; isDirectory(): boolean }>
    } catch {
      continue
    }
    for (const e of entries) {
      const rel = cur === '.' ? e.name : `${cur}/${e.name}`
      const norm = normalizeRel(rel)
      if (e.isDirectory()) {
        const base = e.name
        if (skipDir.has(base)) continue
        if (base.startsWith('.trash-')) continue
        if (norm.includes('chat_uploads')) continue
        stack.push(rel)
      } else {
        if (isExportableRel(norm)) out.push(norm)
        if (out.length >= EXPORT_MAX_FILES) break
      }
    }
  }
  return out
}

async function collectRepoRelPaths(sourcePath: string): Promise<string[]> {
  const [tracked, fsFiles] = await Promise.all([
    listGitTrackedFiles(sourcePath),
    listAllowedFilesFs(sourcePath),
  ])
  const set = new Set<string>()
  for (const p of tracked) if (isExportableRel(p)) set.add(p)
  for (const p of fsFiles) set.add(p)
  return [...set].sort()
}

async function readExportFiles(sourcePath: string, rels: string[]): Promise<Record<string, string>> {
  const fs = await import('fs/promises')
  const files: Record<string, string> = {}
  for (const rel of rels) {
    try {
      const content = await fs.readFile(path.join(sourcePath, rel), 'utf-8')
      if (content.length < EXPORT_MAX_FILE_BYTES) files[rel] = content
    } catch {}
  }
  return files
}

function getBoolParam(value: unknown, defaultValue: boolean): boolean {
  if (value == null) return defaultValue
  if (typeof value === 'boolean') return value
  const s = String(value).toLowerCase()
  if (s === 'false' || s === '0' || s === 'no') return false
  if (s === 'true' || s === '1' || s === 'yes') return true
  return defaultValue
}

interface ExportedSchedule {
  name: string
  action: string
  command?: string
  prompt?: string
  cron: string
  enabled: boolean
  activeFrom?: number
  activeUntil?: number
  agent?: string
  model?: string
}

function exportSchedules(database: Database, repoId: number): ExportedSchedule[] {
  try {
    return scheduleQueries.listSchedules(database, repoId).map((s) => ({
      name: s.name,
      action: s.action,
      command: s.command,
      prompt: s.prompt,
      cron: s.cron,
      enabled: s.enabled,
      activeFrom: s.activeFrom,
      activeUntil: s.activeUntil,
      agent: s.agent,
      model: s.model,
    }))
  } catch {
    return []
  }
}

function restoreSchedules(database: Database, repoId: number, schedules: ExportedSchedule[] | undefined): number {
  if (!Array.isArray(schedules) || schedules.length === 0) return 0
  let count = 0
  for (const s of schedules) {
    if (!s || !s.name || !s.cron) continue
    try {
      scheduleQueries.createSchedule(database, {
        repoId,
        name: s.name,
        action: (s.action as 'prompt' | 'command') ?? 'prompt',
        command: s.command,
        prompt: s.prompt,
        cron: s.cron,
        enabled: s.enabled !== false,
        activeFrom: s.activeFrom,
        activeUntil: s.activeUntil,
        agent: s.agent,
        model: s.model,
      })
      count++
    } catch {}
  }
  return count
}

interface ExportedIndexes {
  gitCommits: Array<{ sha: string; subject: string; body: string | null; author: string | null; branch: string | null; committedAt: number; filesJson: string }>
  repoIndexState: Array<{ branch: string; lastSha: string | null; lastIndexedAt: number | null }>
  sessionMessages: Array<{ text: string; sessionId: string; messageId: string; role: string; turnIndex: number; ts: number }>
}

function exportRepoIndexes(database: Database, repoId: number): ExportedIndexes {
  const empty: ExportedIndexes = { gitCommits: [], repoIndexState: [], sessionMessages: [] }
  try {
    try {
      const rows = database.query(
        'SELECT sha, subject, body, author, branch, committed_at AS committedAt, files_json AS filesJson FROM git_commits WHERE repo_id = ? ORDER BY committed_at DESC LIMIT ?'
      ).all(repoId, INDEX_MAX_ROWS) as ExportedIndexes['gitCommits']
      empty.gitCommits = rows ?? []
    } catch {}
    try {
      const rows = database.query(
        'SELECT branch, last_sha AS lastSha, last_indexed_at AS lastIndexedAt FROM repo_index_state WHERE repo_id = ?'
      ).all(repoId) as ExportedIndexes['repoIndexState']
      empty.repoIndexState = rows ?? []
    } catch {}
    try {
      const rows = database.query(
        'SELECT text, session_id AS sessionId, message_id AS messageId, role, turn_index AS turnIndex, ts FROM session_messages_fts WHERE repo_id = ? LIMIT ?'
      ).all(repoId, INDEX_MAX_ROWS) as ExportedIndexes['sessionMessages']
      empty.sessionMessages = (rows ?? []).filter((r) => typeof r.text === 'string' && r.text.length < EXPORT_MAX_FILE_BYTES)
    } catch {}
  } catch {}
  return empty
}

function restoreRepoIndexes(database: Database, repoId: number, indexes: Partial<ExportedIndexes> | undefined): { commits: number; messages: number } {
  let commits = 0
  let messages = 0
  if (!indexes) return { commits, messages }
  try {
    const gitCommits = Array.isArray(indexes.gitCommits) ? indexes.gitCommits : []
    if (gitCommits.length > 0) {
      const upsert = database.prepare(
        `INSERT INTO git_commits (sha, repo_id, subject, body, author, branch, committed_at, files_json, insertions, deletions)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
         ON CONFLICT(repo_id, sha) DO UPDATE SET subject=excluded.subject, body=excluded.body, author=excluded.author, branch=excluded.branch, committed_at=excluded.committed_at, files_json=excluded.files_json`
      )
      const upsertFts = database.prepare(
        'INSERT INTO git_commits_fts (subject, body, files, sha, repo_id, committed_at) VALUES (?, ?, ?, ?, ?, ?)'
      )
      for (const c of gitCommits.slice(0, INDEX_MAX_ROWS)) {
        if (!c || !c.sha || !c.subject) continue
        try {
          let filesJoined = ''
          try { filesJoined = (JSON.parse(c.filesJson ?? '[]') as string[]).join('\n') } catch { filesJoined = '' }
          database.query('DELETE FROM git_commits_fts WHERE sha = ? AND repo_id = ?').run(c.sha, repoId)
          upsert.run(c.sha, repoId, c.subject, c.body ?? null, c.author ?? null, c.branch ?? null, c.committedAt ?? Date.now(), c.filesJson ?? '[]')
          upsertFts.run(c.subject, c.body ?? '', filesJoined, c.sha, repoId, c.committedAt ?? Date.now())
          commits++
        } catch {}
      }
    }
  } catch {}
  try {
    const states = Array.isArray(indexes.repoIndexState) ? indexes.repoIndexState : []
    for (const s of states) {
      if (!s || !s.branch) continue
      try {
        database.query(
          `INSERT INTO repo_index_state (repo_id, branch, last_sha, last_indexed_at) VALUES (?, ?, ?, ?)
           ON CONFLICT(repo_id, branch) DO UPDATE SET last_sha=excluded.last_sha, last_indexed_at=excluded.last_indexed_at`
        ).run(repoId, s.branch, s.lastSha ?? null, s.lastIndexedAt ?? Date.now())
      } catch {}
    }
  } catch {}
  try {
    const msgs = Array.isArray(indexes.sessionMessages) ? indexes.sessionMessages : []
    if (msgs.length > 0) {
      const ins = database.prepare(
        'INSERT INTO session_messages_fts (text, session_id, message_id, role, repo_id, turn_index, ts) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      for (const m of msgs.slice(0, INDEX_MAX_ROWS)) {
        if (!m || typeof m.text !== 'string' || !m.messageId) continue
        try {
          ins.run(m.text, m.sessionId ?? '', m.messageId, m.role ?? 'unknown', repoId, m.turnIndex ?? 0, m.ts ?? Date.now())
          messages++
        } catch {}
      }
    }
  } catch {}
  return { commits, messages }
}

async function ensureGitRepo(destPath: string): Promise<void> {
  try {
    await executeCommand(['git', '-C', destPath, 'rev-parse', '--git-dir'], { silent: true })
  } catch {
    try { await executeCommand(['git', 'init'], destPath) } catch {}
  }
}

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
      const body = await c.req.json().catch(() => ({})) as { newLocalPath?: string; newName?: string; withIndex?: boolean; withSchedules?: boolean }
      const rawName = (body.newLocalPath || body.newName || '').trim()
      if (!rawName) return c.json({ error: 'newLocalPath is required' }, 400)
      const newLocalPath = rawName.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/\/+$/, '')
      if (!newLocalPath) return c.json({ error: 'invalid newLocalPath' }, 400)
      const withIndex = getBoolParam(body.withIndex ?? c.req.query('withIndex'), true)
      const withSchedules = getBoolParam((body as Record<string, unknown>).withSchedules ?? c.req.query('withSchedules'), true)
      const sourceRepo = db.getRepoById(database, sourceId)
      if (!sourceRepo) return c.json({ error: 'Source repo not found' }, 404)
      if (db.getRepoByLocalPath(database, newLocalPath)) return c.json({ error: 'Target path already exists' }, 409)
      const sourcePath = path.resolve(getReposPath(), path.basename(sourceRepo.localPath))
      const destPath = path.resolve(getReposPath(), newLocalPath)
      const fs = await import('fs/promises')
      try { await fs.access(destPath); return c.json({ error: 'Target directory already exists on disk' }, 409) } catch {}
      await fs.mkdir(destPath, { recursive: true })
      // skill/command/agent/tool + 설정 파일: git 추적 + untracked 모두 수집
      const rels = await collectRepoRelPaths(sourcePath)
      let copiedFiles = 0
      for (const rel of rels) {
        try {
          const srcFile = path.join(sourcePath, rel)
          const destFile = path.join(destPath, rel)
          await fs.mkdir(path.dirname(destFile), { recursive: true })
          await fs.copyFile(srcFile, destFile)
          copiedFiles++
        } catch (e) { logger.warn(`clone copy skip ${rel}:`, e) }
      }
      await ensureGitRepo(destPath)
      // DB 설정 복제: 권한 + 스킬 플래그(true/false 그대로) + opencode config 이름 + 스케줄
      const newRepo = db.createRepo(database, {
        localPath: newLocalPath,
        branch: sourceRepo.branch,
        defaultBranch: sourceRepo.defaultBranch || 'main',
        cloneStatus: 'ready',
        clonedAt: Date.now(),
        isLocal: true,
      })
      let copiedRules = 0
      try {
        const { listPermissionRules, createPermissionRule } = await import('../db/permission-rule-queries')
        const rules = listPermissionRules(database, sourceId)
        for (const r of rules) {
          try { createPermissionRule(database, { repoId: newRepo.id, permission: r.permission, pattern: r.pattern }); copiedRules++ } catch {}
        }
      } catch {}
      try {
        const skill = db.getSkillAutoUpdate(database, sourceId)
        db.setSkillAutoUpdate(database, newRepo.id, skill)
      } catch {}
      try {
        if (sourceRepo.openCodeConfigName) db.updateRepoConfigName(database, newRepo.id, sourceRepo.openCodeConfigName)
      } catch {}
      let copiedSchedules = 0
      if (withSchedules) {
        try { copiedSchedules = restoreSchedules(database, newRepo.id, exportSchedules(database, sourceId)) } catch {}
      }
      // 리콜 인덱스 복제 (git 커밋 + repo_index_state + 세션 메시지 FTS)
      let copiedCommits = 0
      let copiedMessages = 0
      if (withIndex) {
        try {
          const res = restoreRepoIndexes(database, newRepo.id, exportRepoIndexes(database, sourceId))
          copiedCommits = res.commits
          copiedMessages = res.messages
        } catch (e) { logger.warn('clone index copy failed:', e) }
      }
      try {
        const { writeRepoOpenCodeConfig } = await import('../services/default-mcp')
        writeRepoOpenCodeConfig(newLocalPath)
      } catch {}
      try {
        const { preferences } = new SettingsService(database).getSettings()
        await applyRepoTracking(destPath, preferences.repoTrackPaths ?? [])
      } catch {}
      const currentBranch = await repoService.getCurrentBranch(newRepo).catch(() => null)
      logger.info(`Repo cloned ${sourceId} -> ${newRepo.id} (files:${copiedFiles} rules:${copiedRules} schedules:${copiedSchedules} commits:${copiedCommits} messages:${copiedMessages})`)
      return c.json({ ...newRepo, currentBranch, _cloneStats: { copiedFiles, copiedRules, copiedSchedules, copiedCommits, copiedMessages } })
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
      const withIndex = getBoolParam(c.req.query('withIndex'), true)
      const withSchedules = getBoolParam(c.req.query('withSchedules'), true)
      const sourcePath = path.resolve(getReposPath(), path.basename(repo.localPath))
      const rels = await collectRepoRelPaths(sourcePath)
      const files = await readExportFiles(sourcePath, rels)
      const { listPermissionRules } = await import('../db/permission-rule-queries')
      const rules = listPermissionRules(database, id)
      const skillEnabled = db.getSkillAutoUpdate(database, id)
      const schedules = withSchedules ? exportSchedules(database, id) : []
      const indexes = withIndex ? exportRepoIndexes(database, id) : { gitCommits: [], repoIndexState: [], sessionMessages: [] }
      return c.json({
        version: REPO_EXPORT_VERSION,
        exportedAt: Date.now(),
        repo: { repoUrl: repo.repoUrl, localPath: repo.localPath, branch: repo.branch, defaultBranch: repo.defaultBranch, isLocal: repo.isLocal, openCodeConfigName: repo.openCodeConfigName },
        permissionRules: rules.map(r => ({ permission: r.permission, pattern: r.pattern })),
        skillAutoUpdate: skillEnabled,
        openCodeConfigName: repo.openCodeConfigName ?? null,
        schedules,
        files,
        indexes,
        stats: { files: Object.keys(files).length, schedules: schedules.length, rules: rules.length, commits: indexes.gitCommits.length, messages: indexes.sessionMessages.length },
      })
    } catch (error: any) {
      logger.error('Failed to export repo:', error)
      return c.json({ error: error.message }, 500)
    }
  })

  app.post('/import', async (c) => {
    try {
      const body = await c.req.json() as { newLocalPath?: string; data?: any; exportData?: any; withIndex?: boolean; withSchedules?: boolean }
      const data = body.data || body.exportData || body
      const rawName = (body.newLocalPath || data.repo?.localPath || '').trim()
      const newLocalPath = rawName ? rawName.replace(/[^a-zA-Z0-9._-]/g, '-').replace(/\/+$/, '') : `imported-${Date.now()}`
      const withIndex = getBoolParam(body.withIndex ?? (data as Record<string, unknown>).withIndex, true)
      const withSchedules = getBoolParam(body.withSchedules ?? (data as Record<string, unknown>).withSchedules, true)
      if (db.getRepoByLocalPath(database, newLocalPath)) return c.json({ error: 'Target path already exists' }, 409)
      const destPath = path.resolve(getReposPath(), newLocalPath)
      const fs = await import('fs/promises')
      try { await fs.access(destPath); return c.json({ error: 'Target directory already exists on disk' }, 409) } catch {}
      await fs.mkdir(destPath, { recursive: true })
      // write files (v1/v2 모두 허용, exportable 경로만)
      const files = (data.files || {}) as Record<string, string>
      let writtenFiles = 0
      for (const [rawRel, content] of Object.entries(files)) {
        if (typeof content !== 'string') continue
        const rel = normalizeRel(rawRel)
        if (!isExportableRel(rel)) continue
        try {
          const destFile = path.resolve(destPath, rel)
          if (!destFile.startsWith(destPath)) continue
          await fs.mkdir(path.dirname(destFile), { recursive: true })
          await fs.writeFile(destFile, content, 'utf-8')
          writtenFiles++
        } catch {}
      }
      const repoUrl = data.repo?.repoUrl || null
      const branch = data.repo?.branch || undefined
      const defaultBranch = data.repo?.defaultBranch || 'main'
      const isLocal = true
      await ensureGitRepo(destPath)
      const newRepo = db.createRepo(database, {
        repoUrl: repoUrl || undefined,
        localPath: newLocalPath,
        branch,
        defaultBranch,
        cloneStatus: 'ready',
        clonedAt: Date.now(),
        isLocal,
      })
      // restore permission rules + skill flag + config name + schedules + indexes
      let restoredRules = 0
      try {
        const { createPermissionRule } = await import('../db/permission-rule-queries')
        for (const r of (data.permissionRules || [])) {
          try { createPermissionRule(database, { repoId: newRepo.id, permission: r.permission, pattern: r.pattern }); restoredRules++ } catch {}
        }
      } catch {}
      try {
        const skillFlag = typeof data.skillAutoUpdate === 'boolean' ? data.skillAutoUpdate : false
        db.setSkillAutoUpdate(database, newRepo.id, skillFlag)
      } catch {}
      const configName = data.openCodeConfigName || data.repo?.openCodeConfigName
      try { if (configName) db.updateRepoConfigName(database, newRepo.id, configName) } catch {}
      let restoredSchedules = 0
      if (withSchedules) {
        try { restoredSchedules = restoreSchedules(database, newRepo.id, data.schedules) } catch {}
      }
      let restoredCommits = 0
      let restoredMessages = 0
      if (withIndex && data.indexes) {
        try {
          const res = restoreRepoIndexes(database, newRepo.id, data.indexes)
          restoredCommits = res.commits
          restoredMessages = res.messages
        } catch (e) { logger.warn('import index restore failed:', e) }
      }
      try {
        const { writeRepoOpenCodeConfig } = await import('../services/default-mcp')
        writeRepoOpenCodeConfig(newLocalPath)
      } catch {}
      try {
        const { preferences } = new SettingsService(database).getSettings()
        await applyRepoTracking(destPath, preferences.repoTrackPaths ?? [])
      } catch {}
      logger.info(`Repo imported -> ${newRepo.id} (files:${writtenFiles} rules:${restoredRules} schedules:${restoredSchedules} commits:${restoredCommits} messages:${restoredMessages})`)
      const currentBranch = await repoService.getCurrentBranch(newRepo).catch(() => null)
      return c.json({ ...newRepo, currentBranch, _importStats: { writtenFiles, restoredRules, restoredSchedules, restoredCommits, restoredMessages } })
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
