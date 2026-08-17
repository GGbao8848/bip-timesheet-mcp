"""BIP 工时填报 — 考勤扫描模块。

scan_attendance() 将最近 N 天分为四类：
  pending       — 待报工：考勤正常、StdHours>0，尚未提交报工
  reported      — 已报工：考勤接口返回 resultflag="0"+"已有报工记录"
  abnormal      — 考勤异常：有打卡但 StdHours==0（系统无法计算工时）
  no_attendance — 无考勤：无打卡记录或其它异常
"""

from __future__ import annotations

from datetime import date, timedelta

import requests

from config import DEFAULT_ATTN_TIME, DEFAULT_MEAL_TIME, DEFAULT_OVT_HOURS, DEFAULT_STD_HOURS, SCAN_DAYS
from query import query_attendance


def scan_attendance(
    session: requests.Session,
    company_id: str,
    emp_id: str,
    days: int = SCAN_DAYS,
) -> tuple[list, list, list, list]:
    """扫描最近 N 天考勤（从昨天开始，不含当天），返回 (待报工, 已报工, 考勤异常, 无考勤)。

    每项格式:
      pending:       [(date, std_hours, ovt_hours, on_time, off_time), ...]
      reported:      [(date, total_hours, on_time, off_time), ...]
      abnormal:      [(date, on_time, off_time, reason), ...]
      no_attendance: [(date, reason), ...]
    """
    pending: list = []
    reported: list = []
    abnormal: list = []
    no_attendance: list = []

    for i in range(1, days):  # 从昨天开始，不含当天
        d = date.today() - timedelta(days=i)
        ds = d.strftime("%Y-%m-%d")
        attn = query_attendance(session, company_id, emp_id, ds)

        if not attn:
            no_attendance.append((ds, "无考勤记录"))
            continue

        # ── 已报工检测：resultflag="0" ──
        if attn.get("resultflag") == "0":
            err = attn.get("errortext", "")
            if "已有报工" in err:
                on = _fmt_time(attn.get("OnDateTime", ""))
                off = _fmt_time(attn.get("OffDateTime", ""))
                std = float(attn.get("StdHours", 0))
                ovt = float(attn.get("OvtHours", 0))
                reported.append((ds, std + ovt, on, off))
            else:
                no_attendance.append((ds, err or "考勤接口返回异常"))
            continue

        std = float(attn.get("StdHours", 0))
        ovt = float(attn.get("OvtHours", 0))

        if std > 0 or ovt > 0:
            # 考勤正常，待报工
            on = _fmt_time(attn.get("OnDateTime", ""))
            off = _fmt_time(attn.get("OffDateTime", ""))
            pending.append((ds, std, ovt, on, off))
        elif attn.get("OnDateTime"):
            # 有打卡但系统未计算出工时 → 考勤异常
            on = _fmt_time(attn.get("OnDateTime", ""))
            off = _fmt_time(attn.get("OffDateTime", ""))
            abnormal.append((ds, on, off, "无工时数据"))
        else:
            no_attendance.append((ds, "无打卡"))

    return pending, reported, abnormal, no_attendance


def get_default_attendance() -> dict[str, str]:
    """考勤无记录时的默认值。"""
    return {
        "StdHours": DEFAULT_STD_HOURS,
        "OvtHours": DEFAULT_OVT_HOURS,
        "MealTime": DEFAULT_MEAL_TIME,
        "AttnTime": DEFAULT_ATTN_TIME,
    }


def _fmt_time(dt_str: str) -> str:
    """格式化时间字符串，截取前 16 字符 (YYYY-MM-DD HH:MM)。"""
    if not dt_str:
        return ""
    return str(dt_str)[:16]
