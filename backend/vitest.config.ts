import { defineConfig } from 'vitest/config'
import path from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      // 프론트 전용 라이브러리를 쓰는 교차 테스트(pptx 이미지 census)가 있다.
      // 백엔드 node_modules에는 없으므로 서브패스까지 프론트 쪽으로 해석시킨다.
      'ooxml-core/pptx/editor/render/collaboration-sync': path.resolve(
        __dirname,
        '../frontend/node_modules/ooxml-core/dist/pptx/editor/render/collaboration-sync.mjs'
      ),
      'ooxml-core/pptx': path.resolve(__dirname, '../frontend/node_modules/ooxml-core/dist/pptx/index.mjs'),
      'ooxml-core': path.resolve(__dirname, '../frontend/node_modules/ooxml-core'),
      'ooxml-ui': path.resolve(__dirname, '../frontend/node_modules/ooxml-ui'),
      '@opencode-webui/shared': path.resolve(__dirname, '../shared/src'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    // 프론트 모듈 회귀 테스트(실제 구현을 그대로 검증).
    include: ['test/**/*.{test,spec}.ts', '../frontend/test/**/*.{test,spec}.ts'],
    // BrightVPN 실행 중 loopback이 간헐 차단되어 재시도 백오프가 길어진다.
    // 실전형 통합 테스트가 5s 기본값에 걸리지 않게 상향한다.
    testTimeout: 30000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'test/',
        '**/*.test.ts',
        '**/*.spec.ts',
        '**/types/**',
        'vitest.config.ts'
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80
      }
    },
    setupFiles: ['./test/setup.ts']
  }
})
