import { describe, it, expect } from 'vitest'
import os from 'os'
import path from 'path'
import fs from 'fs/promises'

// files.ts/shared가 모듈 로드 시점에 WORKSPACE_PATH를 캡처하므로
// 동적 import보다 먼저 env를 고정한다.
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wsresolve-'))
process.env.WORKSPACE_PATH = tmp

await fs.mkdir(path.join(tmp, 'repos', 'aaa', 'chat_uploads'), { recursive: true })
await fs.mkdir(path.join(tmp, 'repos', 'aaa', 'src'), { recursive: true })
await fs.writeFile(path.join(tmp, 'repos', 'aaa', 'chat_uploads', 'image (7).png'), 'fakepng')
await fs.writeFile(path.join(tmp, 'repos', 'aaa', 'src', 'a.ts'), 'export const a = 1\n')

const { resolveWorkspaceFile } = await import('../../src/services/files')
const reposBase = path.join(tmp, 'repos')
const wantPng = path.join(reposBase, 'aaa', 'chat_uploads', 'image (7).png')

describe('resolveWorkspaceFile (doc-reader 상대경로)', () => {
  it('레포 prefix 상대경로', async () => {
    expect(await resolveWorkspaceFile('aaa/chat_uploads/image (7).png')).toBe(wantPng)
  })
  it('백슬래시 상대경로', async () => {
    expect(await resolveWorkspaceFile('aaa\\chat_uploads\\image (7).png')).toBe(wantPng)
  })
  it('레포명 없는 bare 경로 전 레포 탐색', async () => {
    expect(await resolveWorkspaceFile('chat_uploads/image (7).png')).toBe(wantPng)
    expect(await resolveWorkspaceFile('src/a.ts')).toBe(path.join(reposBase, 'aaa', 'src', 'a.ts'))
  })
  it('repos/ prefix workspace 상대경로', async () => {
    expect(await resolveWorkspaceFile('repos/aaa/chat_uploads/image (7).png')).toBe(wantPng)
  })
  it('정상 절대경로', async () => {
    expect(await resolveWorkspaceFile(wantPng)).toBe(wantPng)
  })
  it('MCP 구형 workspace형 절대경로(<ws>/aaa/...)', async () => {
    expect(await resolveWorkspaceFile(path.join(tmp, 'aaa', 'chat_uploads', 'image (7).png'))).toBe(wantPng)
  })
  it('workspace 밖 절대경로는 403', async () => {
    const outside = path.join(tmp, '..', 'wsresolve-outside.txt')
    await expect(resolveWorkspaceFile(outside)).rejects.toMatchObject({ statusCode: 403 })
  })
  it('없는 파일은 repos 안 경로로 폴백(호출자가 404)', async () => {
    const r = await resolveWorkspaceFile('aaa/nope.png')
    expect(r.startsWith(reposBase + path.sep)).toBe(true)
  })
})
