import { Database } from 'bun:sqlite'
import { logger } from '../utils/logger'
import { mkdirSync } from 'fs'
import { dirname } from 'path'
import { runMigrations } from './migrations'

export function initializeDatabase(dbPath: string = './data/opencode.db'): Database {
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath)
  
  db.run(`
    CREATE TABLE IF NOT EXISTS repos (
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
      is_local BOOLEAN DEFAULT FALSE
    );
    
    CREATE INDEX IF NOT EXISTS idx_repo_clone_status ON repos(clone_status);
    
    CREATE TABLE IF NOT EXISTS user_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'default',
      preferences TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(user_id)
    );
    
    CREATE INDEX IF NOT EXISTS idx_user_id ON user_preferences(user_id);
    
    CREATE TABLE IF NOT EXISTS opencode_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL DEFAULT 'default',
      config_name TEXT NOT NULL,
      config_content TEXT NOT NULL,
      is_default BOOLEAN DEFAULT FALSE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(user_id, config_name)
    );
    
    CREATE INDEX IF NOT EXISTS idx_opencode_user_id ON opencode_configs(user_id);
    CREATE INDEX IF NOT EXISTS idx_opencode_default ON opencode_configs(user_id, is_default);
    
    CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      action TEXT NOT NULL,
      command TEXT,
      prompt TEXT,
      cron TEXT NOT NULL,
      enabled BOOLEAN DEFAULT TRUE,
      last_run_at INTEGER,
      active_from INTEGER,
      active_until INTEGER,
      agent TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    
    CREATE INDEX IF NOT EXISTS idx_schedules_repo ON schedules(repo_id);
    
    CREATE TABLE IF NOT EXISTS permission_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo_id INTEGER NOT NULL,
      permission TEXT NOT NULL,
      pattern TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    
    CREATE INDEX IF NOT EXISTS idx_permission_rules_repo ON permission_rules(repo_id);

    CREATE TABLE IF NOT EXISTS command_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      repo_id INTEGER,
      command_name TEXT NOT NULL,
      args TEXT,
      directory TEXT,
      message_id TEXT,
      status TEXT NOT NULL DEFAULT 'started',
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      created_at INTEGER NOT NULL
    );
    
    CREATE INDEX IF NOT EXISTS idx_command_runs_session ON command_runs(session_id);
    CREATE INDEX IF NOT EXISTS idx_command_runs_repo ON command_runs(repo_id);
    CREATE INDEX IF NOT EXISTS idx_command_runs_started ON command_runs(started_at DESC);
  `)
  
  runMigrations(db)
  
  // Force database file creation by performing a write
  db.prepare('INSERT OR IGNORE INTO user_preferences (user_id, preferences, updated_at) VALUES (?, ?, ?)')
    .run('default', '{}', Date.now())
  
  logger.info('Database initialized successfully')
  
  return db
}
