import type { MessageWithParts, MessageListResponse } from "../api/types";

/**
 * D35 (유휴 렌더 0회) 지원용 순수 비교 도우미.
 *
 * Poll/render 는 "데이터가 실제로 바뀌었는가"만으로 판단한다. 조용하면 캐시 참조를 그대로 두고,
 * 바뀌었을 때만 새 배열/객체를 만들어 렌더를 유발한다.
 *
 * 구조 공유(structuralSharing)만으로는 useMemo가 깨질 수 있어, 길이 비교로 판단한다.
 */

export function textPartsLength(parts: MessageWithParts["parts"]): number {
  let n = 0;
  for (const p of parts) {
    if ((p as { type?: string }).type !== "text") continue;
    n += ((p as { text?: string }).text ?? "").length;
  }
  return n;
}

export function toolOutputLength(parts: MessageWithParts["parts"]): number {
  let n = 0;
  for (const p of parts) {
    if ((p as { type?: string }).type !== "tool") continue;
    const st = (p as { state?: { output?: string; metadata?: { output?: string } } }).state;
    n += (st?.output ?? st?.metadata?.output ?? "").length;
  }
  return n;
}

export function reasoningPartsLength(parts: MessageWithParts["parts"]): number {
  let n = 0;
  for (const p of parts) {
    if ((p as { type?: string }).type !== "reasoning") continue;
    n += ((p as { text?: string }).text ?? "").length;
  }
  return n;
}

export function runningToolCount(parts: MessageWithParts["parts"]): number {
  let n = 0
  for (const p of parts) {
    if ((p as { type?: string }).type !== 'tool') continue
    if ((p as { state?: { status?: string } }).state?.status === 'running') n++;
  }
  return n
}

/**
 * B0-5 확장: tool part의 상태 서명(순서대로 status join).
 * running 개수가 같아도 pending↔running, running↔completed 뒤집힘을 잡는다.
 */
export function toolStatusSignature(parts: MessageWithParts["parts"]): string {
  const out: string[] = []
  for (const p of parts) {
    if ((p as { type?: string }).type !== 'tool') continue
    out.push((p as { state?: { status?: string } }).state?.status ?? '')
  }
  return out.join(',')
}

/** B0-5 확장: tool part의 time.end 서명 (끝난 시각이 다르면 다르다). */
export function toolTimeEndSignature(parts: MessageWithParts["parts"]): string {
  const out: string[] = []
  for (const p of parts) {
    if ((p as { type?: string }).type !== 'tool') continue
    const end = (p as { state?: { time?: { end?: number } } }).state?.time?.end
    out.push(typeof end === 'number' ? String(end) : '')
  }
  return out.join(',')
}

/** B0-5 확장: tool part의 input 유무 서명 (input이 뒤늦게 붙으면 다르다). */
export function toolInputPresence(parts: MessageWithParts["parts"]): string {
  const out: string[] = []
  for (const p of parts) {
    if ((p as { type?: string }).type !== 'tool') continue
    out.push((p as { state?: { input?: unknown } }).state?.input != null ? '1' : '0')
  }
  return out.join(',')
}

export function isCompleted(info: MessageWithParts["info"]): boolean {
  return Boolean((info.time as { completed?: number } | undefined)?.completed);
}

/**
 * 두 메시지의 내용 비교. 종류별 분리 비교다.
 * - 텍스트/툴/추론 각각 길이만 비교한다 (running 120k→완료 20k 축소와 같은 감소도
 *   "길이가 줄었다"로만 판정 → 축소/증가는 별도).
 * - running 개수도 비교한다 (길이가 같아도 running→completed는 다르다).
 */
export function sameMessageContent(a: MessageWithParts, b: MessageWithParts): boolean {
  if (a.parts.length !== b.parts.length) return false;
  if (textPartsLength(a.parts) !== textPartsLength(b.parts)) return false;
  if (toolOutputLength(a.parts) !== toolOutputLength(b.parts)) return false;
  if (reasoningPartsLength(a.parts) !== reasoningPartsLength(b.parts)) return false;
  if (runningToolCount(a.parts) !== runningToolCount(b.parts)) return false;
  // B0-5 확장: 개수·길이가 같아도 상태·종료시각·input 유무가 다르면 다르다.
  if (toolStatusSignature(a.parts) !== toolStatusSignature(b.parts)) return false;
  if (toolTimeEndSignature(a.parts) !== toolTimeEndSignature(b.parts)) return false;
  if (toolInputPresence(a.parts) !== toolInputPresence(b.parts)) return false;
  return isCompleted(a.info) === isCompleted(b.info);
}

/**
 * 메시지 목록 전체 비교. 조용하면 캐시 참조를 그대로 반환해 렌더를 막는다.
 */
export function sameMessageList(a: MessageListResponse, b: MessageListResponse): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ma = a[i]!;
    const mb = b[i]!;
    if (ma.info.id !== mb.info.id) return false;
    if (!sameMessageContent(ma, mb)) return false;
  }
  return true;
}
