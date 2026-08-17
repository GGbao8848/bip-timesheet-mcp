"""BIP 工时填报 - 登录模块。

MCP 每次工具调用都是独立 python 进程，会话缓存必须落盘才能跨调用复用：
get_bip_session() 优先加载本机 TTL 内的 cookie 快照（同一用户连续操作只登录一次），
过期/缺失则全新登录并写回。TTL 默认 600s，可用环境变量 BIP_SESSION_TTL 调整。
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import tempfile
import time
from typing import Any
from urllib.parse import unquote

import requests
from Crypto.Cipher import AES

from config import AES_KEY, AES_IV, BASE_URL, COMPANY_ID

SESSION_TTL_SECONDS = int(os.getenv("BIP_SESSION_TTL", "600"))


def encrypt_password(password: str) -> str:
    """AES-128-CBC 加密密码。"""
    raw = password.encode("utf-8")
    pad_len = 16 - len(raw) % 16
    raw += bytes([pad_len] * pad_len)
    cipher = AES.new(AES_KEY, AES.MODE_CBC, AES_IV)
    return base64.b64encode(cipher.encrypt(raw)).decode("utf-8")


def _new_session() -> requests.Session:
    session = requests.Session()
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Accept": "application/json, text/plain, */*",
        "Origin": "http://10.10.10.247",
        "Referer": "http://10.10.10.247/powerbip/",
    })
    return session


def _cookie_file(username: str) -> str:
    """cookie 快照路径（系统临时目录，按用户哈希命名，避免 git/部署目录污染）。"""
    key = hashlib.sha256(username.encode("utf-8")).hexdigest()[:16]
    return os.path.join(tempfile.gettempdir(), "bip-timesheet", f"{key}.json")


def _load_cached_session(username: str) -> requests.Session | None:
    """TTL 内且有认证 cookie（userid）才复用，否则视为过期返回 None。"""
    path = _cookie_file(username)
    try:
        if time.time() - os.path.getmtime(path) > SESSION_TTL_SECONDS:
            return None
        with open(path, "r", encoding="utf-8") as f:
            cookies = json.load(f)
        session = _new_session()
        session.cookies.update(cookies)
        if not session.cookies.get("userid"):
            return None
        return session
    except Exception:
        return None


def _save_session(username: str, session: requests.Session) -> None:
    """登录态落盘（临时文件 + 原子替换）。失败不影响功能，仅损失一次复用。"""
    try:
        path = _cookie_file(username)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        cookies = requests.utils.dict_from_cookiejar(session.cookies)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cookies, f, ensure_ascii=False)
        os.replace(tmp, path)
    except OSError:
        pass


def get_bip_session(username: str, password: str) -> tuple[requests.Session, dict[str, Any]]:
    """获取 BIP 会话：优先复用本机 TTL 内的登录态，否则全新登录。

    返回 (session, 用户信息)。用户信息来自 cookie（BIP 浏览器端据此自动填写）。
    """
    session = _load_cached_session(username)
    if session is not None:
        return session, {
            "CompanyID": session.cookies.get("companyid", ""),
            "EmpID": session.cookies.get("userid", ""),
            "EmpName": unquote(session.cookies.get("username", "")),
            "CompanyName": unquote(session.cookies.get("companyname", "")),
        }
    session = _new_session()
    info = bip_login(session, username, password)
    _save_session(username, session)
    return session, info


def bip_login(session: requests.Session, username: str, password: str) -> dict[str, Any]:
    """登录 BIP，返回用户信息。

    BIP 用户资料通过 cookie 下发（非登录响应体），浏览器据此自动填写。
    返回字段: CompanyID, EmpID, EmpName, CompanyName
    """
    resp = session.post(
        f"{BASE_URL}/login.do",
        data={
            "UserID": username,
            "UserPwd": encrypt_password(password),
            "_ENCODE_": "UTF-8",
        },
    )
    data = resp.json()

    # 多公司用户 — 选择公司后重新登录
    if data.get("Code") == "SELECTCOMPANY":
        resp = session.post(
            f"{BASE_URL}/login.do",
            data={
                "UserID": username,
                "UserPwd": encrypt_password(password),
                "CompanyID": COMPANY_ID,
                "_ENCODE_": "UTF-8",
            },
        )
        data = resp.json()

    if data.get("Ret") != "1":
        raise RuntimeError(f"登录失败: {data}")

    # 用户信息来自 cookie（BIP 浏览器端据此自动填写）
    return {
        "CompanyID": session.cookies.get("companyid", ""),
        "EmpID": session.cookies.get("userid", ""),
        "EmpName": unquote(session.cookies.get("username", "")),
        "CompanyName": unquote(session.cookies.get("companyname", "")),
    }
