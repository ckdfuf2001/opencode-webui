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


def build_env():
    """LocalSystem에는 H:\\nodejs, 사용자 npm-global이 PATH에 없으므로 보강."""
    env = dict(os.environ)
    extra = []
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
    return env


def find_pnpm(env):
    for name in ("pnpm.cmd", "pnpm"):
        p = shutil.which(name, path=env.get("PATH", ""))
        if p:
            return p
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
    _svc_description_ = "opencode-webui dev stack (pnpm dev: backend 5001 + vite 5173). Logs: <root>\\logs\\dev.log"
    _svc_start_type_ = win32service.SERVICE_AUTO_START

    def __init__(self, args):
        super().__init__(args)
        self.stop_event = threading.Event()
        self.child = None
        self.backoff = 5

    def SvcStop(self):
        svc_log("stop requested")
        self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING)
        self.stop_event.set()
        child, self.child = self.child, None
        if child is not None:
            try:
                if child.poll() is None:
                    kill_tree(child.pid)
                    try:
                        child.wait(timeout=15)
                    except Exception:
                        pass
            except Exception as e:
                svc_log("stop error: %s" % e)
        svc_log("stopped")

    def spawn(self, env):
        os.makedirs(LOGS_DIR, exist_ok=True)
        pnpm = find_pnpm(env)
        if not pnpm:
            raise RuntimeError("pnpm not found (PATH=%s)" % env.get("PATH", ""))
        out = open(OUT_LOG, "ab")
        err = open(ERR_LOG, "ab")
        try:
            child = subprocess.Popen(
                [pnpm, "dev"],
                cwd=PROJECT_DIR,
                env=env,
                stdin=subprocess.DEVNULL,
                stdout=out,
                stderr=err,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except Exception:
            out.close()
            err.close()
            raise
        return child, out, err

    def SvcDoRun(self):
        svc_log("starting in %s" % PROJECT_DIR)
        env = build_env()
        svc_log("PATH head: %s" % ";".join(env.get("PATH", "").split(os.pathsep)[:6]))
        healthy_since = time.time()
        try:
            while not self.stop_event.is_set():
                try:
                    child, out, err = self.spawn(env)
                except Exception as e:
                    svc_log("spawn failed: %s" % e)
                    if self.stop_event.wait(30):
                        break
                    continue
                self.child = child
                svc_log("pnpm dev started (pid %s)" % child.pid)
                start_t = time.time()
                while not self.stop_event.is_set():
                    rc = child.poll()
                    if rc is not None:
                        break
                    if self.stop_event.wait(3):
                        break
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
                    if child.poll() is None:
                        kill_tree(child.pid)
                    break
                rc = child.poll()
                svc_log("pnpm dev exited (code %s), restarting in %ss" % (rc, self.backoff))
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


if __name__ == "__main__":
    if len(sys.argv) == 1:
        print(__doc__)
        sys.exit(2)
    win32serviceutil.HandleCommandLine(DevService)
