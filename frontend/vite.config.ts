import path from "path";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { DEFAULTS } from "../shared/src/config/defaults";

/**
 * 저장소의 .env 에서 KEY=VALUE 를 그대로 읽는다 (간단한 .env 용).
 * loadEnv 는 process.env 를 우선하므로, 다른 설치본이 남긴 환경변수
 * (예: 시스템 전역 PORT=5002) 가 .env 의 PORT 를 덮어쓴다. 그 결과 /api
 * 프록시가 다른 백엔드로 물러나 UI 가 엉뚱한 인스턴스의 데이터를 보여준다.
 * 저장소 .env 가 의도된 값이므로 파일을 직접 읽어 우선한다.
 */
function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return out;
}

function getBuildMeta(): { sha: string; time: string; tag: string } {
  try {
    const sha = execSync("git rev-parse --short HEAD", { encoding: "utf8", timeout: 5000 }).trim();
    // 태그 커밋이 아니어도 가장 가까운 조상 태그를 항상 표시한다.
    // describe 형식: v0.10.4 (정확히 태그 위) / v0.10.4-2-gabc1234 (태그 뒤 2커밋)
    let tag = "";
    try {
      const desc = execSync('git describe --tags --long --match "v[0-9]*" HEAD', { encoding: "utf8", timeout: 5000 }).trim();
      const m = desc.match(/^(.*)-(\d+)-g[0-9a-f]+$/);
      if (m) tag = m[2] === "0" ? m[1]! : `${m[1]}+${m[2]}`;
    } catch {}
    if (/^[0-9a-f]{4,}$/.test(sha)) return { sha, time: new Date().toISOString(), tag };
  } catch {}
  return { sha: "dev", time: new Date().toISOString(), tag: "" };
}
const buildMeta = getBuildMeta();

export default defineConfig(({ mode }) => {
  const repoRoot = path.resolve(__dirname, "..");
  const env = loadEnv(mode, repoRoot, "");
  // .env 파일 값을 최우선으로 쓴다 —ambient PORT 로 다른 백엔드에 물러나면
  // 화면/쓰기가 전부 그 인스턴스에 contra버린다 (설정 삭제가 안 먹히는 symptom).
  const fileEnv = readEnvFile(path.join(repoRoot, ".env"));
  const backendPort = Number(fileEnv.PORT) || Number(env.PORT) || Number(process.env.PORT) || DEFAULTS.SERVER.PORT;
  if (backendPort !== Number(DEFAULTS.SERVER.PORT)) {
    console.log(`[vite] /api proxy -> http://localhost:${backendPort} (from .env)`);
  }

  return {
    envDir: path.resolve(__dirname, ".."),
    plugins: [react(), tailwindcss()],
    define: {
      __BUILD_SHA__: JSON.stringify(buildMeta.sha),
      __BUILD_TIME__: JSON.stringify(buildMeta.time),
      __BUILD_TAG__: JSON.stringify(buildMeta.tag),
    },
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    server: {
      host: "0.0.0.0",
      port: 5173,
      proxy: {
        "/api": {
          target: `http://localhost:${backendPort}`,
          changeOrigin: true,
        },
      },
    },
    esbuild: {
      target: 'es2015',
    },
    build: {
      target: 'es2015',
      assetsInlineLimit: 4096,
      chunkSizeWarningLimit: 600,
      rollupOptions: {
        output: {
          assetFileNames: (assetInfo) => {
            if (assetInfo.name === "manifest.json") {
              return "manifest.json";
            }
            return "assets/[name]-[hash][extname]";
          },
          manualChunks: {
            pdf: ["pdfjs-dist"],
            xlsx: ["xlsx", "jszip"],
            monaco: ["@monaco-editor/react"],
            vendor: ["react", "react-dom", "@tanstack/react-query"],
          },
        },
      },
    },
  };
});
