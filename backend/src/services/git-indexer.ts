import type { Database } from 'bun:sqlite'
import { listRepos, getRepoById } from '../db/queries'
import type { Repo } from '../types/repo'
import { executeCommand } from '../utils/process'
import { logger } from '../utils/logger'
import path from 'node:path'
import fs from 'node:fs'

export const HOST_REPO_ID = 0
export const HOST_REPO_LOCAL_PATH = '__host__'

function getHostRepo(): Repo | null {
  const fullPath = path.resolve(process.cwd())
  try {
    if (!fs.existsSync(path.join(fullPath, '.git'))) return null
  } catch {
    return null
  }
  return {
    id: HOST_REPO_ID,
    localPath: HOST_REPO_LOCAL_PATH,
    fullPath,
    branch: undefined,
    defaultBranch: 'main',
    cloneStatus: 'ready',
    clonedAt: 0,
  } as Repo
}

export function listAllIndexedRepos(db: Database): Repo[] {
  const repos = listRepos(db)
  const host = getHostRepo()
  if (host) repos.push(host)
  return repos
}

function resolveRepoForIndex(db: Database, repoId: number): Repo | null {
  if (repoId === HOST_REPO_ID) return getHostRepo()
  return getRepoById(db, repoId)
}

interface ParsedCommit {
  sha: string
  author: string
  committedAt: number
  subject: string
  body: string
  files: string[]
}

/**
 * repo 의 커밋을 증분 수집해 git_commits + git_commits_fts 에 반영한다.
 * -z 로 커밋을 NUL 청크로 분리해 멀티라인 body 를 안전하게 파싱한다.
 * last_sha 를 시드로 역순(최신→과거)으로 멈춘다.
 */
export async function indexRepoCommits(db: Database, repo: Repo, opts: { force?: boolean } = {}): Promise<number> {
  const repoId = repo.id
  const branch = repo.branch || repo.defaultBranch || 'HEAD'
  let seedSha: string | null = null
  if (!opts.force) {
    const cursor = db
      .query('SELECT last_sha FROM repo_index_state WHERE repo_id = ? AND branch = ?')
      .get(repoId, branch) as { last_sha: string | null } | undefined
    seedSha = cursor?.last_sha ?? null
  }

  const history = await fetchCommitHistory(repo, seedSha)
  if (history.length === 0) return 0

  const upsert = db.prepare(
    `INSERT INTO git_commits
       (sha, repo_id, subject, body, author, branch, committed_at, files_json, insertions, deletions)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
     ON CONFLICT(repo_id, sha) DO UPDATE SET
       subject = excluded.subject,
       body = excluded.body,
       author = excluded.author,
       branch = excluded.branch,
       committed_at = excluded.committed_at,
       files_json = excluded.files_json`,
  )
  const upsertFts = db.prepare(
    `INSERT INTO git_commits_fts (subject, body, files, sha, repo_id, committed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )

  db.query('BEGIN').run()
  try {
    let count = 0
    for (const c of history) {
      const filesJson = JSON.stringify(c.files)
      // FTS 행은 sha 기준 제거 후 재삽입한다 (내용 갱신 반영)
      db.query('DELETE FROM git_commits_fts WHERE sha = ? AND repo_id = ?').run(c.sha, repoId)
      upsert.run(c.sha, repoId, c.subject, c.body, c.author, branch, c.committedAt, filesJson)
      upsertFts.run(c.subject, c.body, c.files.join('\n'), c.sha, repoId, c.committedAt)
      count++
    }
    // 커서 갱신 = 마지막(과거→최신 중 가장 최신) sha
    const newest = history[0]!
    db.query(
      `INSERT INTO repo_index_state (repo_id, branch, last_sha, last_indexed_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(repo_id, branch) DO UPDATE SET last_sha = excluded.last_sha, last_indexed_at = excluded.last_indexed_at`,
    ).run(repoId, branch, newest.sha, Date.now())
    db.query('COMMIT').run()
    return count
  } catch (error) {
    db.query('ROLLBACK').run()
    throw error
  }
}

export async function indexAllRepos(db: Database, opts: { force?: boolean } = {}): Promise<{ repoId: number; indexed: number }[]> {
  const results: { repoId: number; indexed: number }[] = []
  for (const repo of listAllIndexedRepos(db)) {
    try {
      const n = await indexRepoCommits(db, repo, opts)
      results.push({ repoId: repo.id, indexed: n })
    } catch (error) {
      logger.warn(`Failed to index commits for repo ${repo.id} (${repo.localPath}):`, error)
      results.push({ repoId: repo.id, indexed: 0 })
    }
  }
  return results
}

let gitIndexTimer: ReturnType<typeof setInterval> | null = null

/** 주기적으로 모든 레포의 커밋을 증분 인덱싱한다. */
export function startGitCommitIndexer(db: Database, intervalMs = 5 * 60_000): void {
  if (gitIndexTimer) return
  const run = (): void => {
    indexAllRepos(db).catch((error) => logger.warn('Git commit indexer cycle failed:', error))
  }
  run()
  gitIndexTimer = setInterval(run, intervalMs)
}

export function stopGitCommitIndexer(): void {
  if (gitIndexTimer) {
    clearInterval(gitIndexTimer)
    gitIndexTimer = null
  }
}

interface RepoLogRow {
  sha: string
  repoId: number | null
  subject: string
  body: string | null
  author: string | null
  branch: string | null
  committedAt: number
  files: string[]
  insertions: number | null
  deletions: number | null
}

export interface CommitSearchHit {
  sha: string
  repoId: number | null
  subject: string
  author: string | null
  committedAt: number
}

export function searchCommits(
  db: Database,
  q: string,
  opts: { k?: number; repoId?: number | null } = {},
): CommitSearchHit[] {
  const k = Math.max(1, Math.min(50, opts.k ?? 10))
  const tokens = buildCommitQueryTokens(q)
  const where: string[] = []
  const params: (string | number)[] = []
  if (tokens.length > 0) {
    where.push('git_commits_fts MATCH ?')
    params.push(tokens.join(' AND '))
  } else {
    where.push('1 = 1')
  }
  if (opts.repoId != null) {
    where.push('git_commits_fts.repo_id = ?')
    params.push(opts.repoId)
  }
  const order = where[0] === '1 = 1' ? 'c.committed_at DESC' : 'bm25(git_commits_fts)'
  const sql = `
    SELECT c.sha AS sha, c.repo_id AS repoId, c.subject AS subject, c.author AS author,
           c.committed_at AS committedAt
    FROM git_commits_fts
    JOIN git_commits c ON c.repo_id = git_commits_fts.repo_id AND c.sha = git_commits_fts.sha
    WHERE ${where.join(' AND ')}
    ORDER BY ${order}
    LIMIT ?`
  params.push(k)
  const rows = db.query(sql).all(...(params as any[])) as CommitSearchHit[]
  return rows
}

export function getCommitDetail(db: Database, repoId: number, sha: string): RepoLogRow | null {
  type DetailRow = {
    sha: string
    rid: number
    subject: string
    body: string | null
    author: string | null
    branch: string | null
    ct: number
    files: string
  }
  let row = db.query(
    `SELECT sha, repo_id AS rid, subject, body, author, branch, committed_at AS ct,
            files_json AS files
     FROM git_commits WHERE repo_id = ? AND sha = ?`,
  ).get(repoId, sha) as DetailRow | undefined
  if (!row) {
    row = db.query(
      `SELECT sha, repo_id AS rid, subject, body, author, branch, committed_at AS ct,
              files_json AS files
       FROM git_commits WHERE repo_id = ? AND sha LIKE ? ESCAPE '\\' ORDER BY length(sha) ASC LIMIT 1`,
    ).get(repoId, `${sha.replace(/[%_\\]/g, '\\$&')}%`) as DetailRow | undefined
  }
  if (!row) return null
  let files: string[] = []
  try {
    files = JSON.parse(row.files)
  } catch {
    files = []
  }
  return {
    sha: row.sha,
    repoId: row.rid,
    subject: row.subject,
    body: row.body,
    author: row.author,
    branch: row.branch,
    committedAt: row.ct,
    files,
    insertions: null,
    deletions: null,
  }
}

function buildCommitQueryTokens(q: string): string[] {
  return q
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}_\-]/gu, '').trim())
    .filter((t) => t.length > 0)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
}

async function fetchCommitHistory(repo: Repo, seedSha: string | null): Promise<ParsedCommit[]> {
  // %x1e(RS)=커밋 시작, %x1c(FS)=메타 종료/파일목록 시작, %x1f(US)=필드 구분.
  // git 이 출력하지 않는 제어문자라 멀티라인 body 도 안전하게 파싱된다.
  const baseArgs = [
    'git', '-C', repo.fullPath, 'log', '--all', '--date=unix',
    '--pretty=format:%x1e%H%x1f%an%x1f%ct%x1f%s%x1f%b%x1c', '--name-only',
  ]

  let output: string
  try {
    if (seedSha) {
      try {
        output = await executeCommand([...baseArgs, `${seedSha}..`], { cwd: repo.fullPath, silent: true })
      } catch {
        // 시드 sha 가 rebase 등으로 사라졌을 수 있으니 전체 이력으로 재시도한다.
        output = await executeCommand(baseArgs, { cwd: repo.fullPath, silent: true })
      }
    } else {
      output = await executeCommand(baseArgs, { cwd: repo.fullPath, silent: true })
    }
  } catch {
    // HEAD 가 없는 저장소 등은 조용히 빈 결과 처리
    return []
  }

  const commits: ParsedCommit[] = []
  for (const chunk of output.split('\x1e')) {
    if (!chunk) continue
    const fsIdx = chunk.indexOf('\x1c')
    if (fsIdx === -1) continue
    const meta = chunk.slice(0, fsIdx)
    const filesPart = chunk.slice(fsIdx + 1)
    const fields = meta.split('\x1f')
    if (fields.length < 5) continue
    const sha = fields[0]!
    const author = fields[1]!
    const ctStr = fields[2]!
    const subject = fields[3]!
    const body = fields[4]!
    const committedAt = parseInt(ctStr, 10) * 1000
    if (!sha || Number.isNaN(committedAt)) continue
    const files = filesPart
      .split('\n')
      .map((f) => f.trim())
      .filter((f) => f.length > 0)
    commits.push({ sha, author, committedAt, subject, body, files })
  }
  return commits
}
