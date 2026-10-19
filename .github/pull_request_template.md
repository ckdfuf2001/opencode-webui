# PR

## 요약

-

## 메모리 규칙 (docs/decisions.md D26~D36)

- [ ] 새 폴링 / interval / EventSource 없음 (또는 허용 목록 추가 + D29 근거와 측정값 기재)
- [ ] `pnpm check:memory` 통과
- [ ] `pnpm -C backend test -- run` 통과 (기존 `bun:sqlite` 2파일 실패 외 실패 없음)
- [ ] `pnpm -C frontend exec tsc -b` 에러 0
- [ ] 린트 기준선(`pnpm -C frontend exec eslint .` = 330 problems) 신규 0
- [ ] 성능·메모리 변경이면 전/후 표 첨부 (interval run/s, MB/s, JS heap floor)

## 검증

- [ ] 단위 테스트(신규/수정 로직)
- [ ] live probe 전/후 대조 실측
- [ ] E2E 영향 있음: `bun run test:e2e:collab` (실패 시 trace.zip 첨부)

## 메모리 트랙 (M2~M8)

- [ ] 뷰어 닫기 = 언마운트 유지 (D32)
- [ ] 세션 해제는 lease 토큰으로만 (D30·D31)
- [ ] 측정 규칙 준수: 10초 프로브, 벽시계, GC 후 JS heap 병기 (docs/memory-notes.md)
