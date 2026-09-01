import { Database } from 'bun:sqlite'
import { logger } from '../utils/logger'

export function runMigrations(db: Database): void {
  try {
    const tableInfo = db.prepare("PRAGMA table_info(repos)").all() as any[]
    
    const repoUrlColumn = tableInfo.find((col: any) => col.name === 'repo_url')
    if (repoUrlColumn && repoUrlColumn.notnull === 1) {
      logger.info('Migrating repos table to allow nullable repo_url for local repos')
      db.run('BEGIN TRANSACTION')
      try {
        db.run(`
          CREATE TABLE repos_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            repo_url TEXT,
            local_path TEXT NOT NULL,
            branch TEXT,
            default_branch TEXT,
            clone_status TEXT NOT NULL,
            cloned_at INTEGER NOT NULL,
            last_pulled INTEGER,
            opencode_config_name TEXT,
            is_worktree BOOLEAN DEFAULT FALSE,
            is_local BOOLEAN DEFAULT FALSE,
            skill_auto_update BOOLEAN DEFAULT FALSE
          )
        `)
        
        const existingColumns = tableInfo.map((col: any) => col.name)
        const columnsToCopy = ['id', 'repo_url', 'local_path', 'branch', 'default_branch', 'clone_status', 'cloned_at', 'last_pulled', 'opencode_config_name', 'is_worktree', 'is_local']
          .filter(col => existingColumns.includes(col))
        
        const columnsStr = columnsToCopy.join(', ')
        db.run(`INSERT INTO repos_new (${columnsStr}) SELECT ${columnsStr} FROM repos`)
        
        db.run('DROP TABLE repos')
        db.run('ALTER TABLE repos_new RENAME TO repos')
        db.run('COMMIT')
        logger.info('Successfully migrated repos table to allow nullable repo_url')
      } catch (migrationError) {
        db.run('ROLLBACK')
        throw migrationError
      }
    }
    
    const hasBranchColumn = tableInfo.some(col => col.name === 'branch')
    
    if (!hasBranchColumn) {
      logger.info('Adding missing branch column to repos table')
      db.run('ALTER TABLE repos ADD COLUMN branch TEXT')
    }
    
    try {
      db.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_repo_url_branch 
        ON repos(repo_url, branch) 
        WHERE branch IS NOT NULL
      `)
    } catch (error) {
      logger.debug('Index already exists or could not be created', error)
    }
    
    try {
      db.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_local_path 
        ON repos(local_path)
      `)
    } catch (error) {
      logger.debug('Local path index already exists or could not be created', error)
    }
    
    const requiredColumns = [
      { name: 'default_branch', sql: 'ALTER TABLE repos ADD COLUMN default_branch TEXT' },
      { name: 'clone_status', sql: 'ALTER TABLE repos ADD COLUMN clone_status TEXT NOT NULL DEFAULT "cloning"' },
      { name: 'cloned_at', sql: 'ALTER TABLE repos ADD COLUMN cloned_at INTEGER NOT NULL DEFAULT 0' },
      { name: 'last_pulled', sql: 'ALTER TABLE repos ADD COLUMN last_pulled INTEGER' },
      { name: 'opencode_config_name', sql: 'ALTER TABLE repos ADD COLUMN opencode_config_name TEXT' },
      { name: 'is_worktree', sql: 'ALTER TABLE repos ADD COLUMN is_worktree BOOLEAN DEFAULT FALSE' },
      { name: 'is_local', sql: 'ALTER TABLE repos ADD COLUMN is_local BOOLEAN DEFAULT FALSE' },
      { name: 'skill_auto_update', sql: 'ALTER TABLE repos ADD COLUMN skill_auto_update BOOLEAN DEFAULT FALSE' }
    ]
    
    for (const column of requiredColumns) {
      const hasColumn = tableInfo.some(col => col.name === column.name)
      if (!hasColumn) {
        logger.info(`Adding missing column: ${column.name}`)
        try {
          db.run(column.sql)
        } catch (error) {
          logger.debug(`Column ${column.name} might already exist:`, error)
        }
      }
    }
    
    const indexes = [
      'CREATE INDEX IF NOT EXISTS idx_repo_clone_status ON repos(clone_status)',
      'CREATE INDEX IF NOT EXISTS idx_user_id ON user_preferences(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_opencode_user_id ON opencode_configs(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_opencode_default ON opencode_configs(user_id, is_default)'
    ]

    for (const indexSql of indexes) {
      try {
        db.run(indexSql)
      } catch (error) {
        logger.debug('Index already exists:', error)
      }
    }

    try {
      const scheduleTable = db.prepare('PRAGMA table_info(schedules)').all() as any[]
      const scheduleColumns = [
        { name: 'active_from', sql: 'ALTER TABLE schedules ADD COLUMN active_from INTEGER' },
        { name: 'active_until', sql: 'ALTER TABLE schedules ADD COLUMN active_until INTEGER' },
        { name: 'agent', sql: 'ALTER TABLE schedules ADD COLUMN agent TEXT' }
      ]
      for (const column of scheduleColumns) {
        if (!scheduleTable.some(col => col.name === column.name)) {
          logger.info(`Adding missing schedule column: ${column.name}`)
          try {
            db.run(column.sql)
          } catch (error) {
            logger.debug(`Schedule column ${column.name} might already exist:`, error)
          }
        }
      }
    } catch (error) {
      logger.debug('Schedules table may not exist yet:', error)
    }

    // command_runs: origin 컬럼 (ui | schedule)
    try {
      const commandRunTable = db.prepare('PRAGMA table_info(command_runs)').all() as any[]
      if (commandRunTable.length > 0 && !commandRunTable.some(col => col.name === 'origin')) {
        logger.info('Adding missing command_runs column: origin')
        try {
          db.run("ALTER TABLE command_runs ADD COLUMN origin TEXT NOT NULL DEFAULT 'ui'")
        } catch (error) {
          logger.debug('Command run column origin might already exist:', error)
        }
      }
      try {
        db.run('CREATE INDEX IF NOT EXISTS idx_command_runs_repo_started ON command_runs(repo_id, started_at DESC)')
      } catch (error) {
        logger.debug('command_runs composite index already exists:', error)
      }
    } catch (error) {
      logger.debug('command_runs table may not exist yet:', error)
    }
    
    try {
      const repos = db.prepare("SELECT id, local_path FROM repos WHERE local_path LIKE 'repos/%'").all() as any[]
      if (repos.length > 0) {
        logger.info(`Migrating ${repos.length} repos to remove 'repos/' prefix from local_path`)
        const updateStmt = db.prepare("UPDATE repos SET local_path = ? WHERE id = ?")
        for (const repo of repos) {
          const newPath = repo.local_path.replace(/^repos\//, '')
          updateStmt.run(newPath, repo.id)
          logger.info(`Updated repo ${repo.id}: ${repo.local_path} -> ${newPath}`)
        }
      }
    } catch (error) {
      logger.error('Failed to migrate local_path format:', error)
    }
    
    // session_status: pending_permissions 컬럼 (초기 버전 누락 대비)
    try {
      const sessionStatusTable = db.prepare('PRAGMA table_info(session_status)').all() as any[]
      if (sessionStatusTable.length > 0 && !sessionStatusTable.some(col => col.name === 'pending_permissions')) {
        logger.info('Adding missing session_status column: pending_permissions')
        try {
          db.run('ALTER TABLE session_status ADD COLUMN pending_permissions INTEGER NOT NULL DEFAULT 0')
        } catch (error) {
          logger.debug('session_status column pending_permissions might already exist:', error)
        }
      }
    } catch (error) {
      logger.debug('session_status table may not exist yet:', error)
    }

    // command_runs: kind, registry_sha, target_hash, opencode_version
    try {
      const crTable = db.prepare('PRAGMA table_info(command_runs)').all() as any[]
      if (crTable.length > 0) {
        const needed = [
          { name: 'kind', sql: "ALTER TABLE command_runs ADD COLUMN kind TEXT DEFAULT 'command'" },
          { name: 'registry_sha', sql: 'ALTER TABLE command_runs ADD COLUMN registry_sha TEXT' },
          { name: 'target_hash', sql: 'ALTER TABLE command_runs ADD COLUMN target_hash TEXT' },
          { name: 'opencode_version', sql: 'ALTER TABLE command_runs ADD COLUMN opencode_version TEXT' },
        ]
        for (const col of needed) {
          if (!crTable.some((c: any) => c.name === col.name)) {
            logger.info(`Adding missing command_runs column: ${col.name}`)
            try { db.run(col.sql) } catch (e) { logger.debug(`Column ${col.name} might already exist:`, e) }
          }
        }
      }
    } catch (e) {
      logger.debug('command_runs table may not exist yet:', e)
    }

    // untracked_suggestions table (P3/P4 git 추적 제안)
    try {
      db.run(`
        CREATE TABLE IF NOT EXISTS untracked_suggestions (
          id TEXT PRIMARY KEY,
          repo_id INTEGER,
          directory TEXT,
          command_name TEXT NOT NULL,
          file_path TEXT NOT NULL,
          track_path TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          run_id TEXT,
          created_at INTEGER NOT NULL,
          decided_at INTEGER
        )
      `)
      db.run('CREATE INDEX IF NOT EXISTS idx_untracked_repo ON untracked_suggestions(repo_id)')
      db.run('CREATE INDEX IF NOT EXISTS idx_untracked_status ON untracked_suggestions(status)')
    } catch (e) {
      logger.debug('untracked_suggestions table may already exist:', e)
    }

    // ── 전체 대화 검색 (Hermes 세션 검색 계층) ─────────────────────────
    // FTS5 trigram : 한글 부분일치 필수. 인덱스는 opencode DB의 message/part를
    // idle 시점에 pull하여 채운다 (per-message rebuild 전략).
    try {
      db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts USING fts5(
          text,
          session_id UNINDEXED,
          message_id UNINDEXED,
          role UNINDEXED,
          repo_id UNINDEXED,
          turn_index UNINDEXED,
          ts UNINDEXED,
          tokenize='trigram'
        )
      `)
    } catch (e) {
      logger.debug('session_messages_fts table may not be creatable:', e)
    }

    // ── git 커밋 메타데이터 인덱스 (검색의 척추) ─────────────────────────
    try {
      db.run(`
        CREATE TABLE IF NOT EXISTS git_commits (
          sha TEXT NOT NULL,
          repo_id INTEGER NOT NULL,
          subject TEXT NOT NULL,
          body TEXT,
          author TEXT,
          branch TEXT,
          committed_at INTEGER NOT NULL,
          files_json TEXT NOT NULL,
          insertions INTEGER,
          deletions INTEGER,
          PRIMARY KEY (repo_id, sha)
        )
      `)
      db.run('CREATE INDEX IF NOT EXISTS idx_commit_time ON git_commits(repo_id, committed_at DESC)')
    } catch (e) {
      logger.debug('git_commits table may already exist:', e)
    }

    try {
      db.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS git_commits_fts USING fts5(
          subject,
          body,
          files,
          sha UNINDEXED,
          repo_id UNINDEXED,
          committed_at UNINDEXED,
          tokenize='trigram'
        )
      `)
    } catch (e) {
      logger.debug('git_commits_fts table may not be creatable:', e)
    }

    // git 인덱서 증분 커서
    try {
      db.run(`
        CREATE TABLE IF NOT EXISTS repo_index_state (
          repo_id INTEGER NOT NULL,
          branch TEXT NOT NULL,
          last_sha TEXT,
          last_indexed_at INTEGER,
          PRIMARY KEY (repo_id, branch)
        )
      `)
    } catch (e) {
      logger.debug('repo_index_state table may already exist:', e)
    }

    try {
      const orphans = db
        .query(
          `SELECT DISTINCT repo_id FROM session_messages_fts WHERE repo_id IS NOT NULL AND repo_id != 0 AND repo_id NOT IN (SELECT id FROM repos)`,
        )
        .all() as { repo_id: number }[]
      if (orphans.length > 0) {
        const ids = orphans.map((r) => r.repo_id)
        logger.info(`Pruning orphaned search index for deleted repos: ${ids.join(', ')}`)
        for (const { repo_id } of orphans) {
          try {
            db.query('DELETE FROM session_messages_fts WHERE repo_id = ?').run(repo_id)
          } catch {}
          try {
            db.query('DELETE FROM git_commits_fts WHERE repo_id = ?').run(repo_id)
          } catch {}
          try {
            db.query('DELETE FROM git_commits WHERE repo_id = ?').run(repo_id)
          } catch {}
          try {
            db.query('DELETE FROM repo_index_state WHERE repo_id = ?').run(repo_id)
          } catch {}
        }
      }
    } catch (e) {
      logger.debug('orphan prune skipped:', e)
    }

    logger.info('Database migrations completed successfully')
  } catch (error) {
    logger.error('Failed to run database migrations:', error)
    throw error
  }
}
