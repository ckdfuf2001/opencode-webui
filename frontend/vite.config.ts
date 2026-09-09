import path from "path";
import { execSync } from "node:child_process";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { DEFAULTS } from "../shared/src/config/defaults";

function getBuildMeta(): { sha: string; time: string; tag: string } {
  try {
    const sha = execSync("git rev-parse --short HEAD", { encoding: "utf8", timeout: 5000 }).trim();
    let tag = "";
    try {
      tag = execSync("git tag --points-at HEAD", { encoding: "utf8", timeout: 5000 })
        .split("\n")
        .map((t) => t.trim())
        .filter((t) => /^v\d/.test(t))
        .sort()
        .pop() ?? "";
    } catch {}
    if (/^[0-9a-f]{4,}$/.test(sha)) return { sha, time: new Date().toISOString(), tag };
  } catch {}
  return { sha: "dev", time: new Date().toISOString(), tag: "" };
}
const buildMeta = getBuildMeta();

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, path.resolve(__dirname, ".."), "");
  const backendPort = Number(env.PORT) || Number(process.env.PORT) || DEFAULTS.SERVER.PORT;

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
    build: {
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
