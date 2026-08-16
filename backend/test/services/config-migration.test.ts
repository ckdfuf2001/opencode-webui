import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { planConfigMapMigration } from '../../src/services/config-migration'

let tempDir = ''
const fileExists = (p: string) => existsSync(p)

describe('Config map to file migration planning', () => {
  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'mig-rate-'))
    mkdirSync(path.join(tempDir, 'commands'), { recursive: true })
    mkdirSync(path.join(tempDir, 'agents'), { recursive: true })
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('plans config-map commands and agents into global files and drops them from the map', () => {
    const { files, updatedContent } = planConfigMapMigration(
      {
        command: {
          hello: { description: 'hi', agent: 'build', template: 'run it' },
        },
        agent: {
          coder: { description: 'coder', mode: 'subagent', prompt: 'code pls' },
        },
      },
      tempDir,
      fileExists,
    )

    expect(files).toHaveLength(2)
    expect(updatedContent).not.toHaveProperty('command')
    expect(updatedContent).not.toHaveProperty('agent')

    const cmdFile = files.find((f) => f.path.endsWith(path.join('commands', 'hello.md')))
    expect(cmdFile).toBeDefined()
    expect(cmdFile!.content).toContain('description: hi')
    expect(cmdFile!.content).toContain('agent: build')
    expect(cmdFile!.content).toContain('run it')

    const agentFile = files.find((f) => f.path.endsWith(path.join('agents', 'coder.md')))
    expect(agentFile).toBeDefined()
    expect(agentFile!.content).toContain('mode: subagent')
  })

  it('preserves command frontmatter fields topP and subtask', () => {
    const { files } = planConfigMapMigration(
      {
        command: {
          synth: { description: 'sum', agent: 'build', model: 'm', topP: 0.4, subtask: true, template: 'summarize' },
        },
      },
      tempDir,
      fileExists,
    )

    expect(files).toHaveLength(1)
    expect(files[0]!.content).toContain('topP: 0.4')
    expect(files[0]!.content).toContain('subtask: true')
    expect(files[0]!.content).not.toContain('template:')
  })

  it('skips names that already exist as files and keeps the rest in the map', () => {
    writeFileSync(path.join(tempDir, 'commands', 'dup.md'), 'existing', 'utf8')
    const { files, updatedContent } = planConfigMapMigration(
      {
        command: {
          dup: { description: 'd', template: 't' },
          keep: { description: 'k', template: 'tt' },
        },
      },
      tempDir,
      fileExists,
    )

    expect(files).toHaveLength(1)
    expect(files[0]!.path).toContain('keep.md')
    expect(updatedContent.command).toEqual({ dup: { description: 'd', template: 't' } })
  })

  it('sanitizes illegal filename characters in command names', () => {
    const { files } = planConfigMapMigration(
      { command: { 'bad/name:1': { description: 'x', template: 't' } } },
      tempDir,
      fileExists,
    )
    expect(files[0]!.path).toContain('bad-name-1.md')
  })

  it('creates real files on disk via the same content the planner returns', () => {
    const { files } = planConfigMapMigration(
      { command: { hello: { description: 'hi', template: 'run it' } } },
      tempDir,
      fileExists,
    )
    for (const f of files) {
      mkdirSync(path.dirname(f.path), { recursive: true })
      writeFileSync(f.path, f.content, 'utf8')
    }

    const target = path.join(tempDir, 'commands', 'hello.md')
    expect(existsSync(target)).toBe(true)
    const raw = readFileSync(target, 'utf8')
    expect(raw).toContain('description: hi')
    expect(raw).toContain('run it')
  })
})