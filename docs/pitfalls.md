# Pitfalls (e2e/회귀 교훈 한 줄 모음)

- 타이틀바 포털은 슬롯 존재만으로 마운트 금지, `shouldShowPresence` 공용 게이트 사용 (D68 R-ribbon 328px 회귀).
- 재연결 경로 테스트에 close 폴백을 넣지 말 것 — 실제 offline 전파를 가린다 (W0-9a/9b 분리).
