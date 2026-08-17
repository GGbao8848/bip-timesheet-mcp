"""BIP 工时填报 - 查询模块（工作类别、项目、阶段、考勤、成本部门）。"""

from __future__ import annotations

import urllib.parse
from typing import Any

import requests

from config import BASE_URL, WORK_TYPE_CODE


def _resolve_work_type_code(work_type: str) -> str:
    """将显示名（如"部门工作"）映射为 API 内部编码（如"bm"），未知时原样返回。"""
    return WORK_TYPE_CODE.get(work_type, work_type)


def _query(session: requests.Session, company_id: str, src_copied: str,
           xml_detail: str = "") -> list[dict[str, Any]]:
    """通用查询接口。

    Raises:
        RuntimeError: API 返回 Ret≠1 时抛出，包含错误码和消息。
    """
    params: dict[str, str] = {
        "CompanyID": company_id,
        "trancode": "RPT100001D",
        "execmode": "QUERY",
        "SrcCopied": src_copied,
        "mode": "5",
        "_ENCODE_": "UTF-8",
    }
    if xml_detail:
        params["xmldetails"] = xml_detail

    body = urllib.parse.urlencode(params, doseq=True)
    url = f"{BASE_URL}/querylistd.do"
    resp = session.post(
        url,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        timeout=15,
    )
    try:
        data = resp.json()
    except Exception:
        raise RuntimeError(
            f"BIP 查询接口返回非 JSON\n"
            f"  接口: {url}\n"
            f"  SrcCopied: {src_copied}\n"
            f"  HTTP {resp.status_code}: {resp.text[:300]}"
        )
    ret = str(data.get("Ret", ""))
    if ret != "1":
        msg = data.get("Msg", "未知错误")
        code = data.get("Code", "")
        raise RuntimeError(
            f"BIP 查询接口失败 (Ret={ret}, Code={code})\n"
            f"  接口: {url}\n"
            f"  SrcCopied: {src_copied}\n"
            f"  消息: {msg}"
        )
    return data.get("Data", [])


def _parse_bip_table_rows(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """解析 BIP 事务查询返回的表格结构。"""
    result = payload.get("result")
    if not isinstance(result, dict):
        return []

    table = result.get("N")
    if not isinstance(table, dict):
        return []

    header = table.get("T")
    columns: list[str] = []
    if isinstance(header, dict):
        columns = header.get("N", []) or []

    raw_rows = table.get("N")
    if not isinstance(raw_rows, list):
        return []

    rows: list[dict[str, Any]] = []
    for item in raw_rows:
        if not isinstance(item, dict):
            continue
        values: list[Any] = []
        for key, value in item.items():
            if key == "N":
                continue
            if isinstance(value, list):
                values = value
                break
        if not values:
            continue
        row = {
            columns[i] if i < len(columns) else str(i): v
            for i, v in enumerate(values)
        }
        rows.append(row)

    return rows


def query_submitted_reports(
    session: requests.Session,
    company_id: str,
    emp_id: str,
    report_date: str = "",
    audit_status: str = "",
    doc_no: str = "",
) -> list[dict[str, Any]]:
    """查询已提交的报工单（PM300300 mode=5），含审批状态。"""
    params: dict[str, str] = {
        "CompanyID": company_id,
        "trancode": "PM300300",
        "mode": "5",
        "DocType": "RPT",
        "EmpID": emp_id,
        "_ENCODE_": "UTF-8",
    }
    if report_date:
        params["ReportDate"] = report_date
    if audit_status:
        params["AuditStatus"] = audit_status
    if doc_no:
        params["DocNo"] = doc_no

    body = urllib.parse.urlencode(params, doseq=True)
    url = f"{BASE_URL}/querylistd.do"
    resp = session.post(
        url,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        timeout=30,
    )
    try:
        data = resp.json()
    except Exception:
        raise RuntimeError(
            f"BIP 已提交报工单查询返回非 JSON\n"
            f"  接口: {url}\n"
            f"  HTTP {resp.status_code}: {resp.text[:300]}"
        )

    return _parse_bip_table_rows(data)


def query_projects(session: requests.Session, company_id: str, date: str,
                   work_type: str = "xm") -> list[dict[str, Any]]:
    """查询所属项目列表。

    Args:
        work_type: 工作类别，如 "部门工作" / "项目工时" / "销售支持"
    """
    api_code = _resolve_work_type_code(work_type)
    xml = (f'<?xml version="1.0" encoding="GBK" ?>'
           f'<ROOT><xmldetail ReportWorkType="{api_code}" ReportDate="{date}"/></ROOT>')
    return _query(session, company_id, "ProjectList", xml)


def query_phases(session: requests.Session, company_id: str, project_id: str, date: str,
                 work_type: str = "xm") -> list[dict[str, Any]]:
    """查询可选任务/阶段（只返回可报工的）。

    归一化字段名：无论 API 返回 Item/ItemName 还是 TaskID/TaskName，
    最终统一为 TaskID / TaskName / canCheck。

    Args:
        project_id: 项目号，传空字符串时查询系统级/非项目任务。
        work_type: 工作类别
    """
    api_code = _resolve_work_type_code(work_type)
    uses_item_fields = api_code in ("bm", "xs")  # 部门工作 / 销售支持用 Item 字段

    xml = (f'<?xml version="1.0" encoding="GBK" ?>'
           f'<ROOT><xmldetail ReportWorkType="{api_code}" ReportDate="{date}"')
    if project_id:
        xml += f' ProjectID="{project_id}"'
    xml += '/></ROOT>'

    raw = _query(session, company_id, "TaskList", xml)

    result: list[dict[str, Any]] = []
    for p in raw:
        if uses_item_fields:
            # 部门工作 / 销售支持：Item → TaskID, ItemName → TaskName
            # canCheck 由 isLocked / isDeleted 推断
            locked = p.get("isLocked", "0")
            deleted = p.get("isDeleted", "0")
            if locked == "1" or deleted == "1":
                continue
            normalized = dict(p)
            normalized["TaskID"] = p.get("Item", "")
            normalized["TaskName"] = p.get("ItemName", "")
            normalized["canCheck"] = "Y"  # 未锁定且未删除即可选
            result.append(normalized)
        else:
            # 项目工时：已有 TaskID/TaskName/canCheck 字段
            if p.get("canCheck") == "Y":
                result.append(p)

    return result


def query_attendance(session: requests.Session, company_id: str, emp_id: str, date: str) -> dict[str, Any]:
    """查询某日考勤。"""
    xml = (f'<?xml version="1.0" encoding="GBK" ?>'
           f'<ROOT><xmldetail EmpID="{emp_id}" ReportDate="{date}"/></ROOT>')
    result = _query(session, company_id, "GETATTNTIMEBYRPTDATE", xml)
    return result[0] if result else {}


def query_can_report_tasks(
    session: requests.Session,
    company_id: str,
    emp_id: str,
    date: str,
    work_type: str = "bm",
) -> list[dict[str, Any]]:
    """查询用户可报工任务列表（前端"新增"按钮的主渠道）。

    对应前端 SrcCopied=GETCANREPORTTASKSLISTS。
    返回用户已配置/使用过的任务，预填成本部门等信息。
    若为空则需回退到 query_phases() 的 TaskList（全量保底）。

    归一化输出字段与 query_phases 一致：TaskID / TaskName / canCheck。
    """
    api_code = _resolve_work_type_code(work_type)
    xml = (
        f'<?xml version="1.0" encoding="GBK" ?>'
        f'<ROOT><xmldetail EmpID="{emp_id}" ReportDate="{date}"'
        f' ReportWorkType="{api_code}"/></ROOT>'
    )

    url = f"{BASE_URL}/querylistd.do"
    params: dict[str, str] = {
        "CompanyID": company_id,
        "trancode": "RPT100001D",
        "execmode": "QUERY",
        "SrcCopied": "GETCANREPORTTASKSLISTS",
        "xmldetails": xml,
        "mode": "5",
        "_ENCODE_": "UTF-8",
    }
    body = urllib.parse.urlencode(params, doseq=True)
    resp = session.post(
        url,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        timeout=15,
    )
    try:
        data = resp.json()
    except Exception:
        raise RuntimeError(
            f"BIP 可报工任务查询返回非 JSON\n"
            f"  接口: {url}\n"
            f"  SrcCopied: GETCANREPORTTASKSLISTS\n"
            f"  HTTP {resp.status_code}: {resp.text[:300]}"
        )
    ret = str(data.get("Ret", ""))
    if ret != "1":
        msg = data.get("Msg", "未知错误")
        raise RuntimeError(
            f"BIP 可报工任务查询失败 (Ret={ret})\n"
            f"  接口: {url}\n"
            f"  消息: {msg}"
        )

    # 归一化字段名：ReportWorkPhase→TaskID, PhaseName→TaskName
    raw = data.get("Data", []) or []
    result: list[dict[str, Any]] = []
    for item in raw:
        normalized = dict(item)
        normalized["TaskID"] = item.get("ReportWorkPhase", "")
        normalized["TaskName"] = item.get("PhaseName", "")
        normalized["canCheck"] = "Y"  # 主渠道返回的均可选
        result.append(normalized)
    return result
