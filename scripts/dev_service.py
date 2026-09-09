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
        try:
            self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING)
        except Exception:
            pass  # console(run) 모드에서는 SCM 핸들이 없음
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
                port = read_env_port()
                fails = 0
                ever_healthy = False
                ticks = 0
                while not self.stop_event.is_set():
                    rc = child.poll()
                    if rc is not None:
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
                            svc_log("backend unresponsive, killing tree to respawn")
                            kill_tree(child.pid)
                            try:
                                child.wait(timeout=20)
                            except Exception:
                                pass
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


def console_main():
    """SCM 등록 없이 같은 구동 루프를 콘솔에서 실행 (설치 전 검증용)."""
    # ServiceFramework.__init__은 SCM에 핸들러 등록을 시도하므로 우회 생성
    svc = DevService.__new__(DevService)
    svc.stop_event = threading.Event()
    svc.child = None
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
        win32serviceutil.HandleCommandLine(DevService)
