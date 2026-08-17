"""BIP 工时填报 - 登录模块。"""

from __future__ import annotations

import base64
from typing import Any
from urllib.parse import unquote

import requests
from Crypto.Cipher import AES

from config import AES_KEY, AES_IV, BASE_URL, COMPANY_ID


def encrypt_password(password: str) -> str:
    """AES-128-CBC 加密密码。"""
    raw = password.encode("utf-8")
    pad_len = 16 - len(raw) % 16
    raw += bytes([pad_len] * pad_len)
    cipher = AES.new(AES_KEY, AES.MODE_CBC, AES_IV)
    return base64.b64encode(cipher.encrypt(raw)).decode("utf-8")


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
