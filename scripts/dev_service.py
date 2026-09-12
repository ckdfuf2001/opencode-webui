# -*- coding: utf-8 -*-
"""opencode-webui dev stack을 진짜 Windows 서비스(SCM)로 구동.

- 외부 exe/NSSM/스케줄러 불필요. 이미 설치된 Python + pywin32만 사용.
- sc.exe + cmd.exe 조합은 ServiceMain이 없어 1053으로 시작 불가하므로,
  pywin32 ServiceFramework로 정식 서비스 프로토콜을 구현한다.
- PROJECT_DIR은 이 파일 위치 기준으로 자동 결정 (하드코딩 없음).
- LocalSystem 계정 PATH에 node/npm이 없으므로 실행 시 PATH를 보강한다.

사용법 (install/remove/start/stop은 관리자 cmd):
    python scripts\\dev_service.py install      ; 서비스 등록 (자동 시작)
    python scripts\\dev_service.py start        ; 서비스 시작
    python scripts\\dev_service.py stop         ; 서비스 중지
    python scripts\\dev_service.py remove       ; 서비스 삭제
    python scripts\\dev_service.py debug        ; 콘솔에서 직접 실행 (관리자 불필요)
    python scripts\\dev_service.py run          ; SCM 없이 구동 루프만 실행 (설치 전 검증용)
"""
import glob
import os
import shutil
import subprocess
import sys
import threading
import time

import win32event
import win32service
import win32serviceutil

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOGS_DIR = os.path.join(PROJECT_DIR, "logs")
OUT_LOG = os.path.join(LOGS_DIR, "dev.log")
ERR_LOG = os.path.join(LOGS_DIR, "dev.err.log")
SVC_LOG = os.path.join(LOGS_DIR, "dev-service.log")

SERVICE_NAME = "opencode-webui-dev"
SERVICE_DISPLAY = "opencode-webui dev (pnpm dev)"

# 서비스는 LocalSystem으로 돌고, 세션 DB(opencode.db)는 OS 사용자 프로필
# 밑에 있다 (예: C:\Users\oh\.local\share\opencode\opencode.db).
# 그대로 두면 서비스가 systemprofile 쪽 빈 저장소를 봐서
# "레포는 보이고 세션은 안 보이는" 상태가 된다.
# install 시점(관리자 cmd = 실제 사용자)의 프로필을 저장해 두고,
# 실행 시 HOME/USERPROFILE 등을 덮어써서 수동 실행과 같은 저장소를 보게 한다.
PROFILE_DIR = os.path.join(os.environ.get("PROGRAMDATA", r"C:\ProgramData"), "opencode-webui-dev")
PROFILE_FILE = os.path.join(PROFILE_DIR, "user-profile.env")
PROFILE_KEYS = ("USERPROFILE", "APPDATA", "LOCALAPPDATA", "HOMEDRIVE", "HOMEPATH")

# 헬스 워치독: node --watch는 백엔드 크래시 시 종료 대신 파일변경 대기로
# 멈추므로, 프로세스는 살아있어도 응답이 없으면 트리를 죽이고 재기동한다.
# (테스트용으로 DEV_SVC_GRACE_S / DEV_SVC_FAILS 환경변수로 조정 가능)
HEALTH_GRACE_S = int(os.environ.get("DEV_SVC_GRACE_S", "180"))
HEALTH_FAILS = int(os.environ.get("DEV_SVC_FAILS", "6"))
HEALTH_EVERY_S = 15
# 부팅 후 한 번도 healthy를 못 보면 이 시간 후 재기동 (부팅 hang 대비)
NEVER_HEALTHY_S = int(os.environ.get("DEV_SVC_NEVER_S", "300"))


def read_env_port():
    try:
        with open(os.path.join(PROJECT_DIR, ".env"), encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("PORT="):
                    return int(line.split("=", 1)[1].strip().strip("\"'"))
    except Exception:
        pass
    return 5001


def health_ok(port):
    import urllib.request

    try:
        with urllib.request.urlopen(
            "http://127.0.0.1:%d/api/health" % port, timeout=5
        ) as r:
            return r.status == 200
    except Exception:
        return False


def svc_log(msg):
    try:
        os.makedirs(LOGS_DIR, exist_ok=True)
        with open(SVC_LOG, "a", encoding="utf-8") as f:
            f.write(time.strftime("[%Y-%m-%d %H:%M:%S] ") + msg + "\n")
    except Exception:
        pass
    try:
        import servicemanager

        servicemanager.LogInfoMsg(msg)
    except Exception:
        print(msg, flush=True)


def save_user_profile():
    """install 시점의 사용자 프로필 경로를 저장 (관리자 cmd = 실제 사용자).

    SCM 서비스는 LocalSystem으로 돌아서 USERPROFILE이 systemprofile이 되는데,
    opencode 세션 저장소가 사용자 프로필 밑에 있어서 그대로 두면
    서비스 모드에서 세션 목록이 비어 보인다. 저장된 프로필을 실행 시 덮어쓴다."""
    try:
        os.makedirs(PROFILE_DIR, exist_ok=True)
        lines = []
        for k in PROFILE_KEYS:
            v = os.environ.get(k, "")
            if v:
                lines.append("%s=%s" % (k, v))
        if not lines:
            return
        with open(PROFILE_FILE, "w", encoding="utf-8") as f:
            f.write("\n".join(lines) + "\n")
        svc_log("saved user profile env to %s" % PROFILE_FILE)
    except Exception as e:
        svc_log("save user profile failed: %s" % e)


def load_user_profile(env):
    """저장된 사용자 프로필을 실행 환경에 적용. 파일이 없으면 그대로 둔다."""
    try:
        if not os.path.isfile(PROFILE_FILE):
            return env
        with open(PROFILE_FILE, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                if k in PROFILE_KEYS and v and os.path.isdir(v):
                    env[k] = v
        up = env.get("USERPROFILE", "")
        if up and os.path.isdir(up):
            # opencode는 $HOME/.local/share 밑에 세션 DB를 둔다
            env["HOME"] = up
            env.setdefault("XDG_DATA_HOME", os.path.join(up, ".local", "share"))
            env.setdefault("XDG_CONFIG_HOME", os.path.join(up, ".config"))
        svc_log("applied user profile: USERPROFILE=%s" % env.get("USERPROFILE", ""))
    except Exception as e:
        svc_log("load user profile failed: %s" % e)
    return env


def build_env():
    """LocalSystem PATH에는 사용자 영역(node/npm-global/python)이 없으므로 보강.
    특히 python은 이 서비스가 도는 인터프리터 경로를 그대로 쓴다."""
    env = dict(os.environ)
    extra = []
    try:
        py_dir = os.path.dirname(sys.executable)
        for cand in (py_dir, os.path.join(py_dir, "Scripts")):
            if cand and os.path.isdir(cand):
                extra.append(cand)
    except Exception:
        pass
    for cand in (r"H:\nodejs",
                 os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "nodejs")):
        if cand and os.path.isdir(cand):
            extra.append(cand)
    try:
        for npm_dir in glob.glob(r"C:\Users\*\AppData\Roaming\npm"):
            if os.path.isdir(npm_dir):
                extra.append(npm_dir)
    except Exception:
        pass
    seen = set()
    extra = [p for p in extra if not (p.lower() in seen or seen.add(p.lower()))]
    if extra:
        env["PATH"] = os.pathsep.join(extra + [env.get("PATH", "")])
    env = load_user_profile(env)
    return env


def find_pnpm(env):
    for name in ("pnpm.cmd", "pnpm"):
        p = shutil.which(name, path=env.get("PATH", ""))
        if p:
            return p
    return None


def find_bun(env):
    for name in ("bun.exe", "bun"):
        p = shutil.which(name, path=env.get("PATH", ""))
        if p:
            return p
    # fallback: well-known install locations (LocalSystem PATH may miss user bun)
    for cand in (
        os.path.join(os.environ.get("USERPROFILE", ""), ".bun", "bin", "bun.exe"),
        r"C:\Users\ckdfu\.bun\bin\bun.exe",
        os.path.expanduser(r"~\.bun\bin\bun.exe"),
    ):
        if cand and os.path.isfile(cand):
            return cand
    return None


def kill_tree(pid):
    try:
        subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20,
        )
    except Exception as e:
        svc_log("taskkill failed for pid %s: %s" % (pid, e))


class DevService(win32serviceutil.ServiceFramework):
    _svc_name_ = SERVICE_NAME
    _svc_display_name_ = SERVICE_DISPLAY
    _svc_description_ = "opencode-webui dev stack (bun backend + vite 5173, low-mem). Logs: <root>\\logs\\dev.log"
    _svc_start_type_ = win32service.SERVICE_AUTO_START

    def __init__(self, args):
        super().__init__(args)
        self.stop_event = threading.Event()
        self.child = None  # compat: first child pid for legacy callers
        self.backend = None
        self.frontend = None
        self.backoff = 5

    def SvcStop(self):
        svc_log("stop requested")
        try:
            self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING)
        except Exception:
            pass  # console(run) 모드에서는 SCM 핸들이 없음
        self.stop_event.set()
        # kill both trees; keep compat self.child
        for attr in ("frontend", "backend", "child"):
            child = getattr(self, attr, None)
            setattr(self, attr, None)
            if child is not None:
                try:
                    if child.poll() is None:
                        kill_tree(child.pid)
                        try:
                            child.wait(timeout=15)
                        except Exception:
                            pass
                except Exception as e:
                    svc_log("stop error (%s): %s" % (attr, e))
        svc_log("stopped")

    def spawn(self, env):
        """Low-mem spawn: bun --watch backend + vite frontend directly.
        Returns (backend, frontend, out, err). Avoids concurrently (node) and wait-backend.js (node).
        Memory: bun 1 + vite 1 (~300MB) vs old pnpm dev 4 nodes (~600MB+)."""
        os.makedirs(LOGS_DIR, exist_ok=True)
        pnpm = find_pnpm(env)
        if not pnpm:
            raise RuntimeError("pnpm not found (PATH=%s)" % env.get("PATH", ""))
        bun = find_bun(env)
        out = open(OUT_LOG, "ab")
        err = open(ERR_LOG, "ab")
        backend = None
        frontend = None
        try:
            if bun:
                backend_cmd = [bun, "--watch", "backend/src/index.ts"]
                svc_log("spawning backend via bun: %s" % " ".join(backend_cmd))
            else:
                # fallback: node --watch with shim (heavier)
                svc_log("bun not found, fallback to node --watch")
                backend_cmd = [
                    "node",
                    "--watch",
                    "--disable-warning=ExperimentalWarning",
                    "--experimental-transform-types",
                    "--import",
                    "./scripts/node-compat/register.mjs",
                    "backend/src/index.ts",
                ]
            backend = subprocess.Popen(
                backend_cmd,
                cwd=PROJECT_DIR,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=out,
                stderr=err,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            self.backend = backend
            self.child = backend  # compat
            # wait for backend health before starting frontend (replaces node wait-backend.js)
            port = read_env_port()
            svc_log("waiting for backend health on %s (python poll, no extra node)" % port)
            waited = 0
            while waited < 60 and not self.stop_event.is_set():
                if health_ok(port):
                    svc_log("backend healthy, starting frontend")
                    break
                if backend.poll() is not None:
                    svc_log("backend exited early (code %s) before healthy" % backend.poll())
                    break
                if self.stop_event.wait(1):
                    break
                waited += 1
            if self.stop_event.is_set():
                raise RuntimeError("stop requested during backend warmup")
            # start vite frontend (single node process)
            frontend_cmd = [pnpm, "run", "dev:frontend"]
            svc_log("spawning frontend: %s" % " ".join(frontend_cmd))
            frontend = subprocess.Popen(
                frontend_cmd,
                cwd=PROJECT_DIR,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=out,
                stderr=err,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            self.frontend = frontend
        except Exception:
            # cleanup on partial failure
            for p in (frontend, backend):
                if p is not None and p.poll() is None:
                    try:
                        kill_tree(p.pid)
                    except Exception:
                        pass
            out.close()
            err.close()
            self.backend = None
            self.frontend = None
            self.child = None
            raise
        return backend, frontend, out, err

    def SvcDoRun(self):
        svc_log("starting in %s" % PROJECT_DIR)
        env = build_env()
        svc_log("PATH head: %s" % ";".join(env.get("PATH", "").split(os.pathsep)[:6]))
        healthy_since = time.time()
        try:
            while not self.stop_event.is_set():
                try:
                    backend, frontend, out, err = self.spawn(env)
                except Exception as e:
                    svc_log("spawn failed: %s" % e)
                    if self.stop_event.wait(30):
                        break
                    continue
                # keep compat aliases
                self.backend = backend
                self.frontend = frontend
                self.child = backend
                svc_log("stack started (backend pid %s, frontend pid %s)" % (backend.pid, frontend.pid))
                start_t = time.time()
                port = read_env_port()
                fails = 0
                ever_healthy = False
                ticks = 0
                while not self.stop_event.is_set():
                    rc_b = backend.poll()
                    rc_f = frontend.poll()
                    if rc_b is not None:
                        svc_log("backend exited (code %s), restarting stack" % rc_b)
                        # also kill frontend tree if still alive
                        if frontend.poll() is None:
                            kill_tree(frontend.pid)
                        break
                    if rc_f is not None:
                        svc_log("frontend exited (code %s), restarting frontend only" % rc_f)
                        # frontend crash shouldn't kill backend; respawn frontend
                        try:
                            pnpm = find_pnpm(env)
                            if pnpm:
                                frontend = subprocess.Popen(
                                    [pnpm, "run", "dev:frontend"],
                                    cwd=PROJECT_DIR,
                                    env=env,
                                    stdin=subprocess.DEVNULL,
                                    stdout=out,
                                    stderr=err,
                                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                                )
                                self.frontend = frontend
                                svc_log("frontend respawned pid %s" % frontend.pid)
                                continue
                        except Exception as e2:
                            svc_log("frontend respawn failed: %s" % e2)
                        break
                    if self.stop_event.wait(3):
                        break
                    ticks += 1
                    if ticks * 3 < HEALTH_EVERY_S:
                        continue
                    ticks = 0
                    if time.time() - start_t < HEALTH_GRACE_S:
                        continue
                    if health_ok(port):
                        fails = 0
                        ever_healthy = True
                    else:
                        fails += 1
                        svc_log("health check failed (%d/%d)" % (fails, HEALTH_FAILS))
                        dead_long = (not ever_healthy) and (
                            time.time() - start_t > NEVER_HEALTHY_S
                        )
                        if (ever_healthy and fails >= HEALTH_FAILS) or dead_long:
                            svc_log("backend unresponsive, killing backend tree to respawn")
                            kill_tree(backend.pid)
                            try:
                                backend.wait(timeout=20)
                            except Exception:
                                pass
                            break
                # cleanup handles for this iteration
                self.backend = None
                self.frontend = None
                self.child = None
                try:
                    out.close()
                except Exception:
                    pass
                try:
                    err.close()
                except Exception:
                    pass
                if self.stop_event.is_set():
                    for p in (backend, frontend):
                        if p.poll() is None:
                            kill_tree(p.pid)
                    break
                rc = backend.poll()
                svc_log("stack exited (backend code %s), restarting in %ss" % (rc, self.backoff))
                if time.time() - start_t > 120:
                    self.backoff = 5
                    healthy_since = time.time()
                if self.stop_event.wait(self.backoff):
                    break
                self.backoff = min(self.backoff * 2, 60)
                _ = healthy_since
        except Exception as e:
            svc_log("fatal: %s" % e)
        svc_log("run loop ended")


def console_main():
    """SCM 등록 없이 같은 구동 루프를 콘솔에서 실행 (설치 전 검증용)."""
    # ServiceFramework.__init__은 SCM에 핸들러 등록을 시도하므로 우회 생성
    svc = DevService.__new__(DevService)
    svc.stop_event = threading.Event()
    svc.child = None
    svc.backend = None
    svc.frontend = None
    svc.backoff = 5
    try:
        svc.SvcDoRun()
    except KeyboardInterrupt:
        pass
    finally:
        try:
            svc.SvcStop()
        except Exception:
            pass


if __name__ == "__main__":
    if len(sys.argv) == 1:
        print(__doc__)
        sys.exit(2)
    if sys.argv[1] == "run":
        console_main()
    else:
        if sys.argv[1] == "install":
            save_user_profile()
        elif sys.argv[1] == "remove":
            try:
                if os.path.isfile(PROFILE_FILE):
                    os.remove(PROFILE_FILE)
            except Exception:
                pass
        win32serviceutil.HandleCommandLine(DevService)
