import { describe, it, expect } from 'vitest'
import { YCollabSession, buildCollaborationConfig } from '../../../frontend/src/lib/ycollab'

/**
 * T6: owner 리마운트(role 변경)해도 같은 session/doc을 빌려준다.
 * lib adoption 규칙(room에 slides가 있으면 room이 이긴다)과 함께
 * 재seed 위험이 없음을 보장한다.
 */
describe('T6: collaboration config keeps the same doc across remounts', () => {
  it('role change rebuilds config on the same doc; decrypted/solo excluded', () => {
    const session = new YCollabSession('ws://127.0.0.1:9/nope', { name: 't', color: '#000' })
    try {
      const state = { session, roomId: 'f_abc', role: 'owner' as const, intent: 'create' as const }
      const writes: Uint8Array[] = []
      const opts = {
        editing: true,
        viewing: false,
        user: { name: 't', color: '#000' },
        isDecrypted: false,
        writeBackDebounceMs: 2500,
        onWriteBack: (b: Uint8Array) => writes.push(b),
      }
      const c1 = buildCollaborationConfig(state, opts)
      expect(c1).toBeDefined()
      expect(c1!.role).toBe('owner')
      expect(c1!.roomId).toBe('f_abc')
      expect(c1!.sessionIntent).toBe('create')
      // role 변경 리마운트: 같은 doc을 빌려준다.
      const c2 = buildCollaborationConfig({ ...state, role: 'collaborator' }, opts)
      expect(c2!.role).toBe('collaborator')
      expect(
        (c2!.externalSession as unknown as { doc: unknown }).doc,
      ).toBe((c1!.externalSession as unknown as { doc: unknown }).doc)
      // join intent 그대로 전달 (ROOM 승리).
      const c3 = buildCollaborationConfig({ ...state, intent: 'join' as const }, opts)
      expect(c3!.sessionIntent).toBe('join')
      // 보기 모드: viewing일 때만 role viewer로 설정된다.
      const c4 = buildCollaborationConfig(
        { ...state, role: 'viewer' as const },
        { ...opts, editing: false, viewing: true },
      )
      expect(c4!.role).toBe('viewer')
      // 복호화 문서는 제외, solo/닫힘은 undefined.
      expect(buildCollaborationConfig(state, { ...opts, isDecrypted: true })).toBeUndefined()
      expect(buildCollaborationConfig(state, { ...opts, editing: false, viewing: false })).toBeUndefined()
      expect(buildCollaborationConfig(null, opts)).toBeUndefined()
    } finally {
      session.destroy()
    }
  })
})
