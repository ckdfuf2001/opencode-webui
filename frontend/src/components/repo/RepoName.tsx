import type { ReactNode } from "react";

/**
 * 레포명 + #id 표기. id는 이름과 구분되게 muted/mono 처리.
 * truncate 부모 안에서 한 단위로 잘리도록 인라인 유지.
 */
export function RepoName({ id, name }: { id: number | string | null | undefined; name: ReactNode }) {
  return (
    <>
      {id != null && id !== "" && (
        <span className="mr-1 font-mono text-muted-foreground/70">#{id}.</span>
      )}
      {name}
    </>
  );
}
