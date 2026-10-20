/**
 * M15: 커밋 반영 앵커(경로별 모듈 싱글턴).
 *
 * lib 이 커밋 write-back 으로 전달한 바이트는 **커밋이 반영된 모델의 직렬화 결과**다.
 * flush 시점에 "커밋이 반영되었는지"를 판정할 때 앵커로 쓴다.
 *
 * per-component ref 가 아니라 **모듈 级**로 두는 이유: write-back 을 발생시킨 PptxViewer
 * 인스턴스와 flush 를 수행하는 인스턴스가 다를 수 있다(인라인 미리보기/전체화면 시트).
 * 인스턴스별 ref 면 앵커가 null 로 잡혀 판정이 실패한다(실측: anchor=null).
 *
 * 경로로 키를 나눠 다른 파일의 커밋과 섞이지 않게 한다.
 */

const anchors = new Map<string, Uint8Array>()

export function setCommitAnchor(path: string | undefined | null, bytes: Uint8Array): void {
  if (!path) return
  anchors.set(path, new Uint8Array(bytes))
}

export function getCommitAnchor(path: string | undefined | null): Uint8Array | null {
  if (!path) return null
  return anchors.get(path) ?? null
}

export function clearCommitAnchor(path: string | undefined | null): void {
  if (!path) return
  anchors.delete(path)
}
