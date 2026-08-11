import fs from "node:fs";
import path from "path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const BACKEND_PORT_FILE = path.resolve(__dirname, "..", "data", "backend-port.json");
const HEALTH_CHECK_PATH = "/api/health";
const PORT_FILE_WAIT_MS = 30000;
const PORT_FILE_POLL_MS = 500;

const parsePortEnv = (value: string | undefined, fallback: number) => {
  if (!value) return { port: fallback, isRange: false };
  const rangeMatch = value.trim().match(/^(\d+)\s*-\s*(\d+)$/);
  if (rangeMatch) {
    return { port: parseInt(rangeMatch[1], 10), isRange: true };
  }
  const parsed = parseInt(value.trim(), 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid PORT value '${value}'. Use a single port (e.g. 5001) or a range (e.g. 5001-5010).`);
  }
  return { port: parsed, isRange: false };
};

const readBackendPortFile = (): number | null => {
  try {
    if (!fs.existsSync(BACKEND_PORT_FILE)) return null;
    const data = JSON.parse(fs.readFileSync(BACKEND_PORT_FILE, "utf-8"));
    return typeof data.port === "number" ? data.port : null;
  } catch {
    return null;
  }
};

const waitForBackendPort = (): number | null => {
  const deadline = Date.now() + PORT_FILE_WAIT_MS;
  while (Date.now() < deadline) {
    const port = readBackendPortFile();
    if (port) return port;
    const sleepUntil = Date.now() + PORT_FILE_POLL_MS;
    while (Date.now() < sleepUntil) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, PORT_FILE_POLL_MS);
    }
  }
  return null;
};

const checkBackend = async (port: number, isRange: boolean): Promise<void> => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`http://localhost:${port}${HEALTH_CHECK_PATH}`, { signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) {
      console.log(`[vite] Backend API health OK on port ${port}`);
      return;
    }
    throw new Error(`HTTP ${res.status}`);
  } catch {
    if (isRange) {
      console.warn(`[vite] Backend port file resolved to ${port}, but health check failed.`);
    } else {
      console.error(`[vite] Communication failure: backend API not reachable on fixed port ${port}.`);
      console.error(`[vite] The frontend proxy targets http://localhost:${port}, so the WebUI cannot reach the backend.`);
      console.error(`[vite] Start the backend first (npm run dev:backend) or set PORT to a range in .env (e.g. PORT=5001-5010).`);
    }
  }
};

export default defineConfig(async ({ mode }) => {
  const env = loadEnv(mode, path.resolve(__dirname, ".."), "");
  const { port: envPort, isRange } = parsePortEnv(env.PORT, 5001);

  let backendPort = envPort;
  if (isRange) {
    const actualPort = waitForBackendPort();
    if (actualPort) {
      backendPort = actualPort;
      console.log(`[vite] Backend API detected on port ${actualPort} (from ${BACKEND_PORT_FILE})`);
    } else {
      console.warn(`[vite] No backend port file found after ${PORT_FILE_WAIT_MS}ms. Falling back to base port ${envPort}.`);
    }
  } else {
    console.log(`[vite] Using fixed backend port ${envPort} from .env`);
  }

  await checkBackend(backendPort, isRange);

  return {
    envDir: path.resolve(__dirname, ".."),
    plugins: [react(), tailwindcss()],
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
      rollupOptions: {
        output: {
          assetFileNames: (assetInfo: { name?: string }) => {
            if (assetInfo.name === "manifest.json") {
              return "manifest.json";
            }
            return "assets/[name]-[hash][extname]";
          },
        },
      },
    },
  };
});
