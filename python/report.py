#!/usr/bin/env python3
"""BIP 工时填报 CLI —— 命令行驱动的报工与考勤扫描。

用法:
  python report.py -u BRS2395 -p yourpass --scan                          # 扫描考勤
  python report.py -u BRS2395 -p yourpass -d 2026-06-18                   # 非项目类报工
                -w "部门工作" --phase-id T08 -c "日常事务处理"
  python report.py -u BRS2395 -p yourpass -d 2026-06-18                   # 项目类报工
                -w "项目工时" --project-id BRS25905 --phase-id PMTxxx -c "开发功能"
  python report.py -u BRS2395 -p yourpass --auto -w "部门工作"            # 批量自动报工
                --phase-id T08 -c "日常事务处理"
  python report.py -u BRS2395 -p yourpass -d 2026-06-18 \               # 拆分报工
                --item "部门工作|T08|月结问题处理|6|0" \
                --item "部门工作|T02|课题讨论|0|2"
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from datetime import date as dt_date, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import requests
from dotenv import load_dotenv

load_dotenv()

from config import AUDIT_STATUS_MAP, DEFAULT_STD_HOURS, SCAN_DAYS
from login import get_bip_session, force_relogin
from query import (
    query_projects,
    query_phases,
    query_attendance,
    query_submitted_reports,
    query_can_report_tasks,
)
from attendance import scan_attendance, get_default_attendance
from submit import submit_work_hour, submit_work_hour_split, submit_approval, update_status, delete_report, revoke_report, is_non_project

SEP = "=" * 55
MAX_FUZZY_DISPLAY = 30  # 模糊匹配候选列表最多展示条数


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="BIP 工时填报 CLI — 命令行驱动报工与考勤扫描",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
示例:
  %(prog)s -u BRS2395 -p xxx --scan
  %(prog)s -u BRS2395 -p xxx -d 2026-06-18 -w "部门工作" --phase-id T08 -c "日常事务"
  %(prog)s -u BRS2395 -p xxx -d 2026-06-18 -w "项目工时" --project-id BRS25905 --phase-id PMTxxx -c "开发功能"
  %(prog)s -u BRS2395 -p xxx --auto -w "部门工作" --phase-id T08 -c "日常事务"
        """,
    )
    p.add_argument("--username", "-u", help="BIP 账号（默认从 BIP_USERNAME 环境变量读取）")
    p.add_argument("--password", "-p", help="BIP 密码（默认从 BIP_PASSWORD 环境变量读取）")
    p.add_argument("--date", "-d", help="报工日期 YYYY-MM-DD（默认前一天）")
    p.add_argument("--work-type", "-w",
                   choices=["部门工作", "项目工时", "销售支持"],
                   help="工作类别（必填，除非 --scan 模式）")
    p.add_argument("--project-id", help="项目号或名称关键词（支持模糊匹配，部门工作除外）")
    p.add_argument("--phase-id", help="任务/阶段 ID 或名称关键词（支持模糊匹配；未指定时列出可选列表）")
    p.add_argument("--list-phases", action="store_true",
                   help="仅查询可选任务/阶段列表（需配合 -w，可选 -d 和 --project-id）")
    p.add_argument("--hours", type=float, help="报工工时（默认: 考勤自动计算）")
    p.add_argument("--content", "-c", help="报工内容（必填，除非 --scan 模式）")
    p.add_argument("--cost-org", default="", help="成本部门 ID（默认: 项目接口返回或空）")
    p.add_argument("--scan", action="store_true",
                   help=f"仅扫描最近{SCAN_DAYS}天考勤，不提交")
    p.add_argument("--preview", action="store_true",
                   help="一次输出：考勤四分类 + 报工单概况 + 报工表单数据 JSON（报工主入口）")
    p.add_argument("--form-data", action="store_true",
                   help="输出报工表单数据 JSON（系统据此渲染表单卡片）")
    p.add_argument("--sync-options", action="store_true",
                   help="全量拉取静态选项（工作类别/项目/任务）生成 options.json 快照")
    p.add_argument("--submitted", action="store_true",
                   help="查询已提交报工单及审批状态")
    p.add_argument("--audit-status", default="",
                   help="按审批状态筛选已提交报工单（例如 1/2/8）")
    p.add_argument("--doc-no", default="",
                   help="按单号筛选已提交报工单")
    p.add_argument("--delete-doc", default="",
                   help="删除指定 DocNo 的已提交报工单")
    p.add_argument("--revoke-doc", default="",
                   help="撤销指定 DocNo 的审批（支持审批中/审批通过记录）")
    p.add_argument("--auto", action="store_true", help="自动报工所有待报日期（需指定 -w 和 -c）")
    p.add_argument("--item", action="append", default=[],
                   dest="items",
                   help="拆分报工单项：部门工作=类别|任务|内容|标准工时|加班工时（5段），项目类=类别|项目ID|任务|内容|标准工时|加班工时（6段），可重复多次")
    return p


# ── 静态选项快照（工作类别/项目/任务 联动选项，BIP 中近乎静态，定期同步） ──
OPTIONS_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "options.json")
OPTIONS_TTL_SECONDS = 24 * 3600  # 快照超过 24h 后自动重新同步


def _collect_tasks(session: requests.Session, cid: str, eid: str, date_str: str, work_type: str, project_id: str) -> list[dict]:
    """按工作类别（+项目）收集可报工任务：项目类按项目查阶段；部门工作用常用任务，缺失时回退全量列表。"""
    tasks: list[dict] = []
    if work_type in ("项目工时", "销售支持") and project_id:
        # 项目类：阶段属于项目，直接按项目查（不能用工作类别通用任务，否则不同项目看到同一列表）
        tasks = query_phases(session, cid, project_id, date_str, work_type)
    else:
        primary = query_can_report_tasks(session, cid, eid, date_str, work_type)
        if primary:
            tasks = primary
        else:
            tasks = query_phases(session, cid, project_id, date_str, work_type)
    return [{"label": t.get("TaskName", ""), "value": str(t.get("TaskID", ""))}
            for t in tasks if t.get("TaskName") and t.get("TaskID")]


def sync_options(session: requests.Session, cid: str, eid: str, date_str: str = "") -> dict:
    """生成轻量选项快照：工作类别 + 部门工作常用任务 + 历史报工项目（用户实际用过的，数量少）。

    BIP 项目列表上千（项目工时/销售支持），全量预加载不现实；用户报工与历史大概率一致，
    因此只快照「常用任务」与「历史项目」，新项目/新任务在表单中可输入名称，提交时由 agent 模糊匹配。
    """
    if not date_str:
        date_str = (dt_date.today() - timedelta(days=1)).strftime("%Y-%m-%d")
    work_types = ["部门工作", "项目工时", "销售支持"]
    # 常用任务：部门工作（GETCANREPORTTASKSLISTS 用户常用）；项目类需先选项目才能查任务，不预加载
    common_tasks: dict[str, list] = {"部门工作": _collect_tasks(session, cid, eid, date_str, "部门工作", "")}
    # 历史报工项目：从已提交报工单提取 Projects（用户实际用过的）
    recent_projects: list[dict] = []
    seen: set[str] = set()
    try:
        rows = query_submitted_reports(session, cid, eid, doc_no="RPT")
        for r in rows:
            p = (r.get("Projects") or "").strip()
            if p and p not in seen:
                seen.add(p)
                recent_projects.append({"label": p, "value": p})
    except Exception:
        pass
    snapshot = {
        "updatedAt": dt_date.today().isoformat(),
        "workTypes": work_types,
        "commonTasks": common_tasks,
        "recentProjects": recent_projects,
    }
    try:
        with open(OPTIONS_FILE, "w", encoding="utf-8") as f:
            json.dump(snapshot, f, ensure_ascii=False, indent=2)
    except OSError as e:
        print(f"  ⚠️ 写入快照失败: {e}", file=sys.stderr)
    return snapshot


def load_or_sync_options(session: requests.Session, cid: str, eid: str) -> dict:
    """读取选项快照；缺失或过期（>24h）则重新同步（动态注入最新）。"""
    try:
        if os.path.exists(OPTIONS_FILE):
            if time.time() - os.path.getmtime(OPTIONS_FILE) < OPTIONS_TTL_SECONDS:
                with open(OPTIONS_FILE, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if data.get("workTypes") and data.get("tasks"):
                    return data
    except Exception:
        pass
    return sync_options(session, cid, eid)


def build_form_payload(session: requests.Session, cid: str, eid: str, date_str: str = "",
                       scan_result: tuple[list, list] | None = None) -> dict:
    """构造报工表单元数据（--form-data / --preview 共用）。

    日期行集合：指定则查该日，否则取所有待报日/考勤异常日（多天 → 多行表单）。
    scan_result: (pending, abnormal) 已扫描结果，避免 preview 重复扫描 30 天考勤。
    """
    # 1. 日期行集合
    date_rows: list[tuple[str, str, str]] = []  # (date, std_hours, ovt_hours)
    if date_str:
        attn = query_attendance(session, cid, eid, date_str)
        std = float(attn.get("StdHours", 0) or 0)
        ovt = float(attn.get("OvtHours", 0) or 0)
        date_rows = [(date_str, str(std) if std > 0 else "", str(ovt) if ovt > 0 else "0")]
    else:
        if scan_result:
            pending, abnormal = scan_result
        else:
            pending, _reported, abnormal, _no_att = scan_attendance(session, cid, eid)
        if pending:
            date_rows = [(d, str(std) if std > 0 else "", str(ovt) if ovt > 0 else "0") for d, std, ovt, _on, _off in pending]
        elif abnormal:
            date_rows = [(d, "", "") for d, _on, _off, _reason in abnormal]
        else:
            print("❌ 近 30 天无待报工/考勤异常日期，无需报工")
            sys.exit(1)
    # 2. 选项快照（缺失/过期自动刷新）
    options = load_or_sync_options(session, cid, eid)
    # 3. 最近报工模式（预填参考：用户报工与历史大概率一致，主要改内容/工时/拆分）
    first_std = date_rows[0][1] if date_rows else ""
    recent = {"work_type": "部门工作", "phase_id": "", "phase_label": "", "content": "", "std_hours": first_std or "8", "ovt_hours": "0"}
    dept_tasks = options["commonTasks"].get("部门工作") or []
    if dept_tasks:
        recent["phase_id"] = dept_tasks[0]["value"]
        recent["phase_label"] = dept_tasks[0]["label"]
    # 最近一次报工内容（预填参考；记录按日期倒序取最新一条）
    try:
        rows = query_submitted_reports(session, cid, eid, doc_no="RPT")
        if rows:
            rows = sorted(rows, key=lambda r: r.get("ReportDate", ""), reverse=True)
            recent["content"] = (rows[0].get("ReportDesc") or "").strip()
    except Exception:
        pass
    # 4. 输出表单元数据（标记包裹，便于后端提取）；rows 覆盖全部待报日，标准/加班工时分开
    first = date_rows[0] if date_rows else ("", "", "")
    # 5. 历史项目 → 阶段/任务 预加载（项目类需先选项目才能查任务；历史项目数量少可预取）
    proj_date = first[0] or (dt_date.today() - timedelta(days=1)).strftime("%Y-%m-%d")
    project_tasks: dict[str, list] = {}
    for proj in options.get("recentProjects", []) or []:
        pid = (proj.get("value") or "").strip()
        if not pid:
            continue
        try:
            tasks = _collect_tasks(session, cid, eid, proj_date, "项目工时", pid)
        except Exception:
            tasks = []
        if tasks:
            project_tasks[pid] = tasks
    return {
        "date": first[0],
        "hours": first[1],
        "rows": [{"date": d, "std_hours": s, "ovt_hours": o} for d, s, o in date_rows],
        "workTypes": options["workTypes"],
        "commonTasks": options["commonTasks"],
        "recentProjects": options["recentProjects"],
        "projectTasks": project_tasks,
        "recent": recent,
    }


def print_submitted_summary(session: requests.Session, cid: str, eid: str) -> None:
    """输出已提交报工单概况（按审批状态计数，--preview 用，轻量不刷屏）。

    使用与 --submitted 相同的完整枚举（按状态分次查询合并），保证与明细口径一致。
    """
    rows = query_submitted_reports_all(session, cid, eid)
    if not rows:
        print("📋 无已提交报工单。")
        return
    counts: dict[str, int] = {}
    for r in rows:
        s = str(r.get("AuditStatus", "") or "")
        counts[s] = counts.get(s, 0) + 1
    label = " / ".join(
        f"{AUDIT_STATUS_MAP.get(code, '未知')} {n}条" for code, n in sorted(counts.items())
    )
    print(f"📋 已提交报工单概况（近6个月，按月分次查询合并，共 {len(rows)} 条）: {label}")


def print_submitted_detail(
    session: requests.Session,
    cid: str,
    eid: str,
    report_date: str = "",
    audit_status: str = "",
    doc_no: str = "",
) -> None:
    """输出已提交报工单明细（--submitted 用）。

    无筛选时按审批状态分次查询并合并去重，避免 BIP 接口只返回一个批次
    （约 20 条）导致最新/较近记录被旧批次挤掉。
    """
    rows = query_submitted_reports_all(session, cid, eid, report_date=report_date, audit_status=audit_status, doc_no=doc_no)
    if not rows:
        print("✅ 未查询到已提交报工单。")
        return
    rows.sort(key=lambda r: r.get("ReportDate", ""), reverse=True)
    print(f"✅ 已查询到 {len(rows)} 条已提交报工单。")
    print("\n已提交报工单列表:")
    for idx, row in enumerate(rows, 1):
        std_hours = row.get("StdWorkTime", "") or row.get("StdHours", "")
        ovt_hours = row.get("OvtWorkTime", "") or row.get("OvtHours", "")
        real_hours = row.get("RealWorkTime", "") or row.get("RealHours", "")
        hours_parts = []
        if real_hours:
            hours_parts.append(f"总计 {real_hours}h")
        if std_hours or ovt_hours:
            hours_parts.append(f"标准 {std_hours}h 加班 {ovt_hours}h")
        hours_label = f"  工时: {' / '.join(hours_parts)}" if hours_parts else ""
        print("\n" + "-" * 55)
        print(f"[{idx}] DocNo: {row.get('DocNo', '')}")
        print(f"    ReportDate: {row.get('ReportDate', '')}{hours_label}")
        status_code = str(row.get('AuditStatus', '') or "")
        status_label = AUDIT_STATUS_MAP.get(status_code, "")
        if status_label:
            print(f"    AuditStatus: {status_code} ({status_label})")
        else:
            print(f"    AuditStatus: {status_code}")
        print(f"    ReportStatus: {row.get('ReportStatus', '')}")
        print(f"    创建时间: {row.get('CreateDate', '')}  创建人: {row.get('CreateUsr', '')}")
        print(f"    审核时间: {row.get('AuditDate', '')}  审核人: {row.get('AuditUsr', '')}")
        desc = row.get('ReportDesc', '') or ''
        if len(desc) > 120:
            desc = desc[:117] + '...'
        print(f"    ReportDesc: {desc}")


def query_submitted_reports_all(
    session: requests.Session,
    cid: str,
    eid: str,
    report_date: str = "",
    audit_status: str = "",
    doc_no: str = "",
    months: int = 6,
) -> list[dict]:
    """完整枚举已提交报工单：支持筛选，无筛选时按月分次查询合并。

    BIP 接口每次只返回一个批次（约 20 条）且批次内容不稳定，无筛选时直接查会
    漏掉最近/较近记录。而 DocNo 前缀按 LIKE 匹配且结果确定性（验证：RPT2608 →
    当月 10 条完整）。因此无筛选查询按「近 N 个月的 RPTyyyyMM 前缀」分次查询、
    按 DocNo 去重合并；某月恰好返回满批次（20 条）时再按审批状态补查该月，
    防止单月记录被截断。筛选查询（日期/状态/单号）直接单次查询即可。
    """
    if audit_status or report_date or doc_no:
        rows = query_submitted_reports(session, cid, eid, report_date=report_date, audit_status=audit_status, doc_no=doc_no)
        return list(rows)

    merged: dict[str, dict] = {}
    today = dt_date.today()
    month_codes: list[str] = []
    y, m = today.year, today.month
    for _ in range(months):
        month_codes.append(f"{y % 100:02d}{m:02d}")  # DocNo 前缀为 RPT+YYMM
        m -= 1
        if m == 0:
            y -= 1
            m = 12
    for ym in month_codes:  # 从近到远
        prefix = f"RPT{ym}"
        rows = query_submitted_reports(session, cid, eid, doc_no=prefix)
        for r in rows:
            merged[str(r.get("DocNo", ""))] = r
        # 单月达到批次上限（20 条）→ 按审批状态分次补查该月，覆盖被截断的记录
        if len(rows) >= 20:
            for code in ("1", "2", "32", "4", "8", "16"):
                for r in query_submitted_reports(session, cid, eid, audit_status=code, doc_no=prefix):
                    merged[str(r.get("DocNo", ""))] = r
    return list(merged.values())


def print_scan_results(pending: list, reported: list, abnormal: list, no_attendance: list) -> None:
    """格式化打印考勤扫描结果（四分类）。"""
    print(f"\n{'=' * 55}")
    print(f"📊 考勤扫描结果 (最近{SCAN_DAYS}天)")
    print(f"{'=' * 55}")

    if pending:
        print("\n🔴 待报工 (考勤正常、尚未提交):")
        for i, (ds, std, ovt, on, off) in enumerate(pending, 1):
            total = (std + ovt) if (std or ovt) else ""
            ovt_note = f"（含加班{ovt}h）" if ovt else ""
            print(f"  [{i}] {ds}  {total}h{ovt_note}  打卡: {on} → {off}")
    else:
        print("\n✅ 无待报工日期")

    if reported:
        print("\n🟢 已报工:")
        for ds, hours, on, off in reported:
            print(f"  {ds}  {hours}h  打卡: {on} → {off}")

    if abnormal:
        print("\n🟡 考勤异常 (有打卡但无工时数据):")
        for ds, on, off, reason in abnormal:
            print(f"  {ds}  打卡: {on} → {off}  ({reason})")

    if no_attendance:
        print("\n⚪ 无考勤:")
        for ds, reason in no_attendance:
            print(f"  {ds}  {reason}")

    print()


def fuzzy_match(items: list, query: str, id_key: str, name_key: str,
                label: str = "项目/任务") -> dict:
    """通用模糊匹配：支持按 ID 或名称匹配。

    匹配优先级：
      1. ID 精确匹配（忽略大小写）
      2. 名称精确匹配（忽略大小写）
      3. 名称包含查询字符串（忽略大小写）

    多匹配或无匹配时打印候选列表并 exit(1)，
    单匹配时返回匹配到的 dict。
    """
    q = query.strip().lower()

    # 1. ID 精确匹配
    exact_id = [item for item in items
                if str(item.get(id_key, "")).strip().lower() == q]
    if len(exact_id) == 1:
        return exact_id[0]

    # 2. 名称精确匹配
    exact_name = [item for item in items
                  if str(item.get(name_key, "")).strip().lower() == q]
    if len(exact_name) == 1:
        return exact_name[0]

    # 3. 名称包含查询字符串
    fuzzy = [item for item in items
             if q in str(item.get(name_key, "")).strip().lower()]

    if len(fuzzy) == 0:
        print(f"❌ 未找到匹配 \"{query}\" 的{label}")
        _print_candidate_list(items, id_key, name_key)
        sys.exit(1)

    if len(fuzzy) > 1:
        print(f"⚠️ \"{query}\" 匹配到多个{label}，请更精确地指定:")
        _print_candidate_list(fuzzy, id_key, name_key)
        sys.exit(1)

    return fuzzy[0]


def _print_candidate_list(items: list, id_key: str, name_key: str) -> None:
    """打印候选列表，超过 MAX_FUZZY_DISPLAY 条时截断。"""
    for item in items[:MAX_FUZZY_DISPLAY]:
        print(f"   {item.get(id_key, '')} — {item.get(name_key, '')}")
    if len(items) > MAX_FUZZY_DISPLAY:
        print(f"   ... 还有 {len(items) - MAX_FUZZY_DISPLAY} 条，请用更精确的关键词筛选")


def fuzzy_match_phase(phases: list, query: str) -> dict:
    """模糊匹配任务/阶段（fuzzy_match 的便捷封装）。"""
    return fuzzy_match(phases, query, "TaskID", "TaskName", "任务/阶段")


def fuzzy_match_project(projects: list, query: str) -> dict:
    """模糊匹配项目（fuzzy_match 的便捷封装）。"""
    return fuzzy_match(projects, query, "ProjectID", "ProjectName", "项目")


def resolve_attendance(session: requests.Session, cid: str, emp_id: str, date_str: str, hours: float | None, *, skip_reported_check: bool = False) -> dict:
    """查询考勤并计算实际工时。

    只有考勤接口明确返回空/错误时（无打卡、已报工）才用默认值。
    考勤返回 StdHours=0（异常打卡）时不用默认值——让用户用 --hours 指定。

    Args:
        skip_reported_check: 拆分报工时设为 True，跳过"已有报工"的报错。
    """
    attn = query_attendance(session, cid, emp_id, date_str)

    # 无考勤数据 → 允许用默认值
    if not attn:
        print(f"  ⚠️ 考勤无记录，使用默认值: 标准=8h, 加班=0h, 吃饭=1h, 考勤=8h")
        attn = get_default_attendance()
    elif attn.get("resultflag") == "0":
        err = attn.get("errortext", "")
        if "已有报工" in err:
            if skip_reported_check:
                print(f"  ⚠️ 该日期已有报工记录，使用考勤默认值继续拆分报工。")
                attn = get_default_attendance()
            else:
                print(f"  ❌ 该日期已有报工记录，不能重复提交。如需修改，请先删除原报工单后重新报工。")
                sys.exit(1)
        else:
            # 其他 resultflag="0" 的情况（非报工类异常）→ 使用默认值
            print(f"  ⚠️ 考勤接口返回异常（{err}），使用默认值: 标准=8h, 加班=0h, 吃饭=1h, 考勤=8h")
            attn = get_default_attendance()
    elif float(attn.get("StdHours", 0)) == 0 and float(attn.get("OvtHours", 0)) == 0:
        # 有打卡但工时为 0 → 考勤异常，不静默替换
        if hours is None and not skip_reported_check:
            print(f"  ❌ 考勤工时=0（打卡异常），无法自动计算工时。请用 --hours 显式指定工时后重试")
            sys.exit(1)
        # 用户显式指定了 --hours，使用用户值（拆分模式允许零工时考勤）
        pass

    if hours is not None:
        real = hours
    else:
        real = float(attn.get("StdHours", 0)) + float(attn.get("OvtHours", 0))
        if real <= 0:
            real = float(DEFAULT_STD_HOURS)

    print(f"  标准={attn.get('StdHours', 0)}h, 加班={attn.get('OvtHours', 0)}h, "
          f"吃饭={attn.get('MealTime', 0)}h, 考勤={attn.get('AttnTime', 0)}h")
    print(f"  → 报工工时: {real}h")
    return attn, real


def resolve_project_and_phase(
    session: requests.Session,
    cid: str,
    date_str: str,
    work_type: str,
    project_id: str | None,
    phase_id: str | None,
) -> tuple[dict | None, dict | None]:
    """查询并匹配项目与阶段。

    Returns: (project_dict, phase_dict)
    """
    # 非项目类：优先用主渠道 GETCANREPORTTASKSLISTS，空则回退 TaskList
    if is_non_project(work_type):
        primary = query_can_report_tasks(session, cid, session.cookies.get("userid", ""), date_str, work_type)
        fallback = query_phases(session, cid, "", date_str, work_type) if primary else None
        if primary:
            tasks = primary
        elif fallback:
            tasks = fallback
        else:
            tasks = query_phases(session, cid, "", date_str, work_type)
        if not tasks:
            print(f"❌ 工作类别 {work_type} 无可选任务")
            sys.exit(1)
        if phase_id:
            # 先在主渠道匹配，匹配不到则回退到保底列表
            try:
                phase = fuzzy_match_phase(tasks, phase_id)
            except SystemExit:
                if fallback and fallback != tasks:
                    print(f"  ℹ️ 常用任务中未找到，回退到全量列表匹配...")
                    phase = fuzzy_match_phase(fallback, phase_id)
                else:
                    raise
        else:
            print("❌ 非项目类报工需要选择工作任务，请用 --phase-id 指定：")
            for t in tasks:
                print(f"   {t['TaskID']} — {t['TaskName']}")
            sys.exit(1)
        print(f"  ✅ 任务: {phase.get('TaskName', '')} ({phase.get('TaskID', '')})")
        return None, phase

    # 项目类：查询项目列表
    projects = query_projects(session, cid, date_str, work_type)
    if not projects:
        print(f"❌ 工作类别 {work_type} 无可用项目")
        sys.exit(1)

    if not project_id:
        # 按创建时间倒序，展示最近项目
        sorted_projects = sorted(
            projects,
            key=lambda p: p.get("CreateDate", ""),
            reverse=True,
        )
        print(f"❌ 请用 --project-id 指定项目（共 {len(projects)} 个，支持 ProjectID 或名称关键词模糊匹配）")
        print("   最近项目（前20个）:")
        for p in sorted_projects[:20]:
            pid = p.get('ProjectID', '')
            pname = p.get('ProjectName', '')
            pdate = p.get('CreateDate', '')[:10] if p.get('CreateDate') else ''
            print(f"   {pid} — {pname}  ({pdate})")
        if len(sorted_projects) > 20:
            print(f"   ... 还有 {len(sorted_projects) - 20} 个项目")
        print("   💡 提示: 可用名称关键词搜索，如 --project-id 蔚来")
        sys.exit(1)

    matched = fuzzy_match_project(projects, project_id)

    print(f"  ✅ 项目: {matched['ProjectID']} — {matched.get('ProjectName', '')}")

    # 查询阶段
    phases = query_phases(session, cid, project_id, date_str, work_type)
    if not phases:
        print(f"❌ 项目 {project_id} 无可报工阶段")
        sys.exit(1)

    phase = None
    if phase_id:
        phase = fuzzy_match_phase(phases, phase_id)
    else:
        print("❌ 请用 --phase-id 指定阶段：")
        for p in phases:
            print(f"   {p.get('TaskID', '')} — {p.get('TaskName', '')}")
        sys.exit(1)

    print(f"  ✅ 阶段: {phase['TaskName']} ({phase['TaskID']})")
    return matched, phase


def run_single(
    session: requests.Session,
    cid: str,
    emp_id: str,
    date_str: str,
    work_type: str,
    project_id: str | None,
    phase_id: str | None,
    hours: float | None,
    content: str,
    cost_org: str,
) -> bool:
    """执行单日报工完整流程。返回是否成功。"""
    print(f"\n{SEP}")
    print(f"📅 {date_str}")
    print(f"{SEP}")

    # Step 1: 考勤
    print("[1/4] 获取考勤...")
    attn, real = resolve_attendance(session, cid, emp_id, date_str, hours)

    # Step 2: 项目/阶段
    print("[2/4] 查询报工信息...")
    print(f"  工作类别: {work_type}")
    project, phase = resolve_project_and_phase(session, cid, date_str, work_type, project_id, phase_id)
    org_id = session.cookies.get("orgid", "")

    # Step 3: 提交
    print("[3/4] 提交工时填报...")
    try:
        result = submit_work_hour(
            session, cid, emp_id, date_str, phase, project, attn, content,
            work_type=work_type, cost_org=cost_org, org_id=org_id,
        )
    except Exception as e:
        print(f"  ❌ 提交失败: {e}")
        return False

    doc_no = result["Data"][0]["DocNo"]
    oaflow = result["Data"][0]["oaflow"]
    print(f"  ✅ DocNo={doc_no}")

    # Step 4: 审批 + 状态
    print("[4/4] 提交审批 & 修改状态...")
    try:
        submit_approval(session, oaflow)
        print("  ✅ 审批已发起")
    except Exception as e:
        print(f"  ⚠️ 审批失败: {e}")
        return False

    try:
        update_status(session, cid, doc_no)
        print("  ✅ 状态已更新")
    except Exception as e:
        print(f"  ⚠️ 状态修改失败: {e}")
        return False

    print(f"\n✅ {date_str} 完成! DocNo={doc_no}")
    return True


def _parse_split_items(cli_items: list[str]) -> list[dict]:
    """解析 --item 参数：管道分隔纯文本，无 JSON/文件依赖。

    部门工作：类别|任务|内容|标准工时|加班工时（5段）
    项目类/销售：类别|项目ID|任务|内容|标准工时|加班工时（6段）
    """
    items: list[dict] = []

    for raw in cli_items:
        parts = raw.split("|")
        if len(parts) == 5:
            work_type, phase_id, content, std_str, ovt_str = parts
            project_id = None
        elif len(parts) == 6:
            work_type, project_id, phase_id, content, std_str, ovt_str = parts
        else:
            print(f"❌ --item 格式错误（5段=部门工作: 类别|任务|内容|标准工时|加班工时 / 6段=项目类: 类别|项目ID|任务|内容|标准工时|加班工时）: {raw}")
            sys.exit(1)
        try:
            std_h = float(std_str)
            ovt_h = float(ovt_str)
        except ValueError:
            print(f"❌ --item 工时解析失败: {raw}")
            sys.exit(1)
        item = {
            "work_type": work_type.strip(),
            "phase_id": phase_id.strip(),
            "content": content.strip(),
            "std_hours": std_h,
            "ovt_hours": ovt_h,
        }
        if project_id is not None:
            item["project_id"] = project_id.strip()
        items.append(item)

    if not items:
        print("❌ --item 未提供任何拆分项")
        sys.exit(1)

    required = {"work_type", "phase_id", "content", "std_hours", "ovt_hours"}
    for i, item in enumerate(items):
        missing = required - set(item.keys())
        if missing:
            print(f"❌ 第 {i + 1} 项缺少字段: {', '.join(missing)}")
            sys.exit(1)
        for hk in ("std_hours", "ovt_hours"):
            if not isinstance(item[hk], (int, float)) or item[hk] < 0:
                print(f"❌ 第 {i + 1} 项 {hk} 必须是非负数")
                sys.exit(1)
        if item["work_type"] not in ("部门工作", "项目工时", "销售支持"):
            print(f"❌ 第 {i + 1} 项 work_type 无效: {item['work_type']}")
            sys.exit(1)

    return items


def run_split(
    session: requests.Session,
    cid: str,
    emp_id: str,
    date_str: str,
    items: list[dict],
) -> bool:
    """执行拆分报工：一次提交含多条明细行（单 DocNo 多 DetailSeq）。

    流程：
      1. 获取当天考勤
      2. 逐项解析阶段/项目 → 构建含 phase/project 的 items
      3. 单次 submit_work_hour_split 提交全部明细
      4. 审批 + 修改状态
    """
    print(f"\n{'=' * 55}")
    print(f"📅 {date_str}  拆分报工（{len(items)} 项）")
    print(f"{'=' * 55}")

    # Step 1: 获取考勤
    print("\n[1/5] 获取考勤...")
    attn, _real = resolve_attendance(session, cid, emp_id, date_str, None)

    total_std = float(attn.get("StdHours", 0))
    total_ovt = float(attn.get("OvtHours", 0))
    total_attn = total_std + total_ovt

    # Step 2: 验证拆分工时
    print("\n[2/5] 验证拆分工时...")
    split_std = sum(it["std_hours"] for it in items)
    split_ovt = sum(it["ovt_hours"] for it in items)
    split_total = split_std + split_ovt
    print(f"  拆分标准工时: {split_std}h, 拆分加班工时: {split_ovt}h, 合计: {split_total}h")

    if total_attn > 0:
        print(f"  考勤总工时: {total_attn}h (标准={total_std}h, 加班={total_ovt}h)")
        if split_std > total_std:
            print(f"  ⚠️ 拆分标准工时({split_std}h) > 考勤标准工时({total_std}h)")
        if split_ovt > total_ovt:
            print(f"  ⚠️ 拆分加班工时({split_ovt}h) > 考勤加班工时({total_ovt}h)")

    # Step 3: 逐项解析阶段/项目
    print(f"\n[3/5] 解析阶段/项目（共 {len(items)} 项）...")
    resolved_items: list[dict] = []
    for i, item in enumerate(items):
        item_num = i + 1
        work_type = item["work_type"]
        phase_id = item["phase_id"]
        project_id = item.get("project_id")
        content = item["content"]
        std_h = float(item["std_hours"])
        ovt_h = float(item["ovt_hours"])

        print(f"\n  ── 第 {item_num}/{len(items)} 项 ──")
        print(f"  工作类别: {work_type}")
        print(f"  内容: {content}")
        print(f"  工时: 标准={std_h}h, 加班={ovt_h}h")

        if std_h == 0 and ovt_h == 0:
            print(f"  ⚠️ 工时为 0，跳过此项")
            continue

        try:
            project, phase = resolve_project_and_phase(
                session, cid, date_str, work_type, project_id, phase_id,
            )
        except SystemExit:
            print(f"  ❌ 第 {item_num} 项阶段解析失败，终止")
            return False

        resolved_items.append({
            "work_type": work_type,
            "phase": phase,
            "project": project,
            "content": content,
            "std_hours": std_h,
            "ovt_hours": ovt_h,
            "cost_org": item.get("cost_org", ""),
        })

    if not resolved_items:
        print("\n❌ 所有项工时为 0，无需提交")
        return False

    # Step 4: 单次提交全部明细
    org_id = session.cookies.get("orgid", "")
    print(f"\n[4/5] 提交拆分报工（{len(resolved_items)} 条明细）...")
    try:
        result = submit_work_hour_split(
            session, cid, emp_id, date_str, attn, resolved_items,
            org_id=org_id,
        )
    except Exception as e:
        print(f"  ❌ 提交失败: {e}")
        return False

    doc_no = result["Data"][0]["DocNo"]
    oaflow = result["Data"][0]["oaflow"]
    print(f"  ✅ DocNo={doc_no}")

    # Step 5: 审批 + 状态
    print("\n[5/5] 提交审批 & 修改状态...")
    try:
        submit_approval(session, oaflow)
        print("  ✅ 审批已发起")
    except Exception as e:
        print(f"  ⚠️ 审批失败: {e}")
        return False

    try:
        update_status(session, cid, doc_no)
        print("  ✅ 状态已更新")
    except Exception as e:
        print(f"  ⚠️ 状态修改失败: {e}")
        return False

    # 汇总
    print(f"\n{'=' * 55}")
    print(f"✅ 拆分报工完成! DocNo={doc_no}")
    for i, item in enumerate(resolved_items, 1):
        phase_name = (item["phase"] or {}).get("TaskName", "")
        print(f"  [{i}] {item['content'][:40]}  ({item['std_hours']}h标准 + {item['ovt_hours']}h加班)  → {phase_name}")
    print(f"{'=' * 55}")
    return True


def main() -> None:
    args = build_parser().parse_args()

    # ── 解析凭证：命令行 -u/-p > 环境变量 BIP_USERNAME/BIP_PASSWORD > .env ──
    username = args.username or os.getenv("BIP_USERNAME", "")
    password = args.password or os.getenv("BIP_PASSWORD", "")
    if not username:
        print("❌ 缺少账号，请用 -u 参数或设置环境变量 BIP_USERNAME")
        sys.exit(1)
    if not password:
        print("❌ 缺少密码，请用 -p 参数或设置环境变量 BIP_PASSWORD")
        sys.exit(1)

    # ── 会话过期检测与自动重登录 ──
    # BIP 为单会话：缓存复用的登录态可能已被别处登录踢下线（接口报"登录已过期"）。
    # 检测到后强制重新登录并重试一次；写操作（报工/删除/撤销/状态修改）不重试，
    # 避免重复提交。用户显式指定的删除/撤销单号原样保留。
    SESSION_EXPIRED_MSGS = (
        "登录已过期或者已经在其他地方登录",
        "登录已过期",
        "会话过期",
        "请重新登录",
    )

    def _session_expired(msg: str) -> bool:
        return any(k in msg for k in SESSION_EXPIRED_MSGS)

    def _is_write() -> bool:
        # 只读操作：preview / scan / submitted / form-data / list-phases / sync-options
        if args.preview or args.scan or args.submitted or args.form_data or args.list_phases or args.sync_options:
            return False
        # 其余（--auto / --item / 单日报工 / --delete-doc / --revoke-doc）均为写操作，不自动重试
        return True

    def call_with_retry(session_obj: requests.Session, call, *a, **kw):
        """执行调用；会话过期时强制重登录后重试一次。写操作不重试（防重复提交）。

        call 的首个位置参数必须是 session；*a 为其余位置参数（不含 session）。
        """
        try:
            return call(session_obj, *a, **kw)
        except RuntimeError as e:
            if _session_expired(str(e)) and not _is_write():
                print(f"  ⚠️ 会话已过期，重新登录后重试...")
                session_obj, _info = force_relogin(username, password)
                return call(session_obj, *a, **kw)
            raise

    _q = lambda s, fn, *a, **kw: call_with_retry(s, fn, *a, **kw)

    # ── 登录（复用本机 TTL 内的会话缓存，同一用户连续操作只登录一次） ──
    print("🔐 正在登录 BIP...")
    try:
        session, login_result = get_bip_session(username, password)
    except Exception as e:
        print(f"❌ 登录失败: {e}")
        sys.exit(1)

    cid = login_result["CompanyID"]
    eid = login_result["EmpID"]
    name = login_result["EmpName"]
    print(f"✅ 登录成功: {name} ({cid}/{eid})")

    # ── --list-phases: 仅查询可选任务/阶段列表 ──
    if args.list_phases:
        if not args.work_type:
            print("❌ --list-phases 需要指定 -w/--work-type（部门工作 / 项目工时 / 销售支持）")
            sys.exit(1)
        date_str = args.date or (dt_date.today() - timedelta(days=1)).strftime("%Y-%m-%d")
        pid = args.project_id or ""
        if not is_non_project(args.work_type) and not pid:
            print("❌ 项目工时/销售支持 需要指定 --project-id 来查询阶段列表")
            sys.exit(1)

        # 主渠道：GETCANREPORTTASKSLISTS（用户已配置的任务）
        primary = _q(session, query_can_report_tasks, cid, eid, date_str, args.work_type)
        if primary:
            print(f"📋 {args.work_type} 常用任务/阶段 ({len(primary)} 个):")
            for t in primary:
                extra = f"  成本部门: {t.get('CostOrg', '')}" if t.get('CostOrg') else ""
                print(f"   {t['TaskID']} — {t['TaskName']}{'  (' + extra + ')' if extra else ''}")
            print()
        else:
            print(f"📋 {args.work_type} 无常用任务，查询全部可选列表...")

        # 保底：TaskList（全量任务）
        tasks = _q(session, query_phases, cid, pid, date_str, args.work_type)
        if tasks:
            label = "全部" if primary else ""
            print(f"📋 {args.work_type} {label}可选任务/阶段 ({len(tasks)} 个):".replace("  ", " "))
            for t in tasks:
                print(f"   {t.get('TaskID', '')} — {t.get('TaskName', '')}")
        elif not primary:
            print(f"✅ 工作类别 {args.work_type} 无可选任务/阶段。")
        return

    # ── --scan: 仅扫描考勤 ──
    if args.scan:
        print(f"🔍 扫描考勤 (最近{SCAN_DAYS}天)...")
        pending, reported, abnormal, no_att = _q(session, scan_attendance, cid, eid)
        print_scan_results(pending, reported, abnormal, no_att)
        return

    # ── --sync-options: 全量拉取静态选项快照 ──
    if args.sync_options:
        print("🔍 同步报工选项快照...")
        _q(session, sync_options, cid, eid)
        print(f"✅ 已生成选项快照: {OPTIONS_FILE}")
        return

    # ── --preview: 一次输出 考勤四分类 + 报工单概况 + 表单数据（报工主入口） ──
    if args.preview:
        print(f"🔍 扫描考勤 (最近{SCAN_DAYS}天)...")
        pending, reported, abnormal, no_att = _q(session, scan_attendance, cid, eid)
        print_scan_results(pending, reported, abnormal, no_att)
        print("🔎 查询已提交报工单概况...")
        _q(session, print_submitted_summary, cid, eid)
        payload = _q(session, build_form_payload, cid, eid, args.date or "", scan_result=(pending, abnormal))
        print("【表单数据】" + json.dumps(payload, ensure_ascii=False) + "【表单数据结束】")
        return

    # ── --form-data: 输出报工表单元数据（系统据此渲染表格型表单卡片） ──
    if args.form_data:
        payload = _q(session, build_form_payload, cid, eid, args.date or "")
        print("【表单数据】" + json.dumps(payload, ensure_ascii=False) + "【表单数据结束】")
        return

    # ── --delete-doc: 删除指定已提交报工单（审批中自动先撤销再删除；审批通过(8)拒绝删除） ──
    if args.delete_doc:
        print(f"🗑️ 删除报工单 {args.delete_doc}...")
        # 先查状态，审批通过(8)不可删除
        rows = _q(session, query_submitted_reports, cid, eid, doc_no=args.delete_doc)
        if rows:
            status_code = str(rows[0].get("AuditStatus", "") or "")
            if status_code == "8":
                print(f"❌ 该报工单审批已通过，不可删除。")
                return
        try:
            result = delete_report(session, cid, args.delete_doc)
        except Exception as e:
            err_msg = str(e)
            if "DELFAIL" in err_msg:
                print(f"   ⚠️ 记录处于审批状态，先尝试撤销...")
                try:
                    revoke_report(session, cid, args.delete_doc)
                except Exception as re:
                    print(f"❌ 撤销失败: {re}")
                    sys.exit(1)
                print(f"   ✅ 撤销成功，继续删除...")
                try:
                    result = delete_report(session, cid, args.delete_doc)
                except Exception as e2:
                    print(f"❌ 删除失败: {e2}")
                    sys.exit(1)
            else:
                print(f"❌ 删除失败: {e}")
                sys.exit(1)
        print(f"✅ 删除成功: {result.get('Msg', '')}")
        return

    # ── --revoke-doc: 撤销指定报工单的审批 ──
    if args.revoke_doc:
        print(f"↩️ 撤销审批 {args.revoke_doc}...")
        rows = _q(session, query_submitted_reports, cid, eid, doc_no=args.revoke_doc)
        if not rows:
            print(f"❌ 未找到 DocNo={args.revoke_doc} 的报工单。")
            return
        status_code = str(rows[0].get("AuditStatus", "") or "")
        if status_code in ("1", "2", "8", "16"):
            label = AUDIT_STATUS_MAP.get(status_code, "未知")
            print(f"❌ 不能撤销当前状态的记录，AuditStatus={status_code}（{label}）。")
            return
        try:
            result = revoke_report(session, cid, args.revoke_doc)
        except Exception as e:
            print(f"❌ 撤销失败: {e}")
            sys.exit(1)
        print(f"✅ 撤销成功: {result.get('Msg', '')}")
        return

    # ── --submitted: 查询已提交报工单 ──
    if args.submitted:
        print("🔎 查询已提交报工单...")
        # 无筛选时按审批状态分次查询合并，保证最近记录不遗漏（详见 query_submitted_reports_all）
        print_submitted_detail(
            session, cid, eid,
            report_date=args.date or "",
            audit_status=args.audit_status,
            doc_no=args.doc_no or "",
        )
        return

    # ── --auto: 批量自动报工（只提交待报工日期） ──
    if getattr(args, "auto"):
        if not args.work_type:
            print("❌ --auto 模式需要指定 -w/--work-type（部门工作 / 项目工时 / 销售支持）")
            sys.exit(1)
        if not args.content:
            print("❌ --auto 模式需要指定 -c/--content（报工内容）")
            sys.exit(1)
        content = args.content
        print(f"🔍 扫描考勤 (最近{SCAN_DAYS}天)...")
        pending, reported, abnormal, no_att = _q(session, scan_attendance, cid, eid)
        print_scan_results(pending, reported, abnormal, no_att)

        if not pending:
            print("✅ 无待报工日期，无需操作")
            if abnormal:
                print(f"⚠️  有 {len(abnormal)} 天考勤异常（工时=0），需手动指定 --hours 单独报工:")
                for ds, on, off, reason in abnormal:
                    print(f"     {ds}  打卡: {on} → {off}  ({reason})")
            return

        print(f"🚀 自动报工 {len(pending)} 个待报工日期...")
        success = 0
        for ds, _std, _ovt, on, off in pending:
            ok = run_single(
                session, cid, eid, ds,
                work_type=args.work_type,
                project_id=args.project_id,
                phase_id=args.phase_id,
                hours=args.hours,
                content=content,
                cost_org=args.cost_org,
            )
            if ok:
                success += 1
            # 避免连续提交触发服务端 S1000
            time.sleep(2)
        print(f"\n{SEP}")
        print(f"🎉 批量报工完成: {success}/{len(pending)} 天成功")
        if abnormal:
            print(f"⚠️  跳过了 {len(abnormal)} 天考勤异常（工时=0），需手动指定 --hours 单独报工:")
            for ds, on, off, reason in abnormal:
                print(f"     {ds}  打卡: {on} → {off}  ({reason})")
        return

    # ── --item: 拆分报工 ──
    if args.items:
        items = _parse_split_items(args.items)
        date_str = args.date or (dt_date.today() - timedelta(days=1)).strftime("%Y-%m-%d")
        ok = run_split(session, cid, eid, date_str, items)
        if not ok:
            sys.exit(1)
        return

    # ── 单日模式 ──
    date_str = args.date or (dt_date.today() - timedelta(days=1)).strftime("%Y-%m-%d")
    if not args.work_type:
        print("❌ 请指定 -w/--work-type（部门工作 / 项目工时 / 销售支持）")
        sys.exit(1)
    if not args.content:
        print("❌ 请指定 -c/--content（报工内容）")
        sys.exit(1)
    content = args.content

    ok = run_single(
        session, cid, eid, date_str,
        work_type=args.work_type,
        project_id=args.project_id,
        phase_id=args.phase_id,
        hours=args.hours,
        content=content,
        cost_org=args.cost_org,
    )

    if ok:
        pid = args.project_id or "非项目类"
        print(f"\n{SEP}")
        print(f"🎉 报工完成！")
        print(f"   日期: {date_str}")
        print(f"   项目: {pid}")
        print(f"   工时: {args.hours or '考勤自动'}h")
        print(f"   内容: {content}")
        print(f"{SEP}")
    else:
        sys.exit(1)


if __name__ == "__main__":
    main()
