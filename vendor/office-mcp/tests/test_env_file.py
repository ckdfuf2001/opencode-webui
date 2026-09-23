"""gen-env + .env autoload tests for server.py."""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import server as srv


def test_gen_env_creates_root_active_rest_commented(tmp_path) -> None:
    target = tmp_path / "deploy"
    path = srv.cmd_gen_env(str(target))
    assert path == os.path.join(str(target), ".env")
    body = open(path, encoding="utf-8").read()
    assert f"OPCODE_WEBUI_ROOT={target}" in body
    assert "\n# OFFICE_BRIDGE_PORT=8766" in body
    # 재실행은 멱등 — 기존 값 유지, 추가 없음
    again = srv.cmd_gen_env(str(target))
    assert again == path
    assert open(path, encoding="utf-8").read() == body


def test_gen_env_defaults_to_cwd(tmp_path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    path = srv.cmd_gen_env(None)
    assert path == os.path.join(str(tmp_path), ".env")
    assert f"OPCODE_WEBUI_ROOT={tmp_path}" in open(path, encoding="utf-8").read()


def test_load_env_file_sets_missing_only(tmp_path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("OPCODE_WEBUI_ROOT", raising=False)
    monkeypatch.delenv("OFFICE_BRIDGE_PORT", raising=False)
    with open(tmp_path / ".env", "w", encoding="utf-8") as fh:
        fh.write("OPCODE_WEBUI_ROOT=/from/file\nOFFICE_BRIDGE_PORT=8777\nPORT=9999\n")
    monkeypatch.setenv("OFFICE_BRIDGE_PORT", "8000")
    found = srv.load_env_file()
    assert found == os.path.join(str(tmp_path), ".env")
    assert os.environ["OPCODE_WEBUI_ROOT"] == "/from/file"
    # 실 env 우선 — 파일 값으로 덮지 않는다
    assert os.environ["OFFICE_BRIDGE_PORT"] == "8000"
    # allowlist 밖 키는 흘러들어오지 않는다
    assert os.environ.get("PORT") != "9999"
