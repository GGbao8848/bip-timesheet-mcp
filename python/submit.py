"""BIP 工时填报 — 提交 / 审批 / 状态修改模块。"""

from __future__ import annotations

import json
import sys
import urllib.parse
from typing import Any

import requests

from config import BASE_URL

_SUFFIX = "[由Agent辅助填写并提交]"


def xml_escape(value: Any) -> str:
    """XML 特殊字符转义（等价于前端 n() 函数）。"""
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        value = ",".join(str(v) for v in value)
    s = str(value)
    return s.replace("&", "&amp;").replace("<", "&lt;").replace('"', "&quot;")


def is_non_project(work_type: str) -> bool:
    """判断是否为非项目类工作类别（仅 部门工作 不需要关联项目）。"""
    return work_type == "部门工作"


def _bip_assert(step_name: str, url: str, resp: requests.Response) -> dict[str, Any]:
    """统一检查 BIP 接口返回：HTTP 状态 + JSON + Ret=1。"""
    try:
        resp.raise_for_status()
    except Exception as exc:
        raise RuntimeError(
            f"BIP 接口 HTTP 失败\n"
            f"  步骤: {step_name}\n"
            f"  接口: {url}\n"
            f"  错误: {exc}"
        )
    try:
        data = resp.json()
    except Exception:
        raise RuntimeError(
            f"BIP 接口返回非 JSON\n"
            f"  步骤: {step_name}\n"
            f"  接口: {url}\n"
            f"  内容: {resp.text[:500]}"
        )
    if str(data.get("Ret")) != "1":
        raise RuntimeError(
            f"BIP 接口返回失败 (Ret≠1)\n"
            f"  步骤: {step_name}\n"
            f"  接口: {url}\n"
            f"  返回: {json.dumps(data, ensure_ascii=False, indent=2)}"
        )
    return data


def submit_work_hour(
    session: requests.Session,
    cid: str,
    emp_id: str,
    date: str,
    phase: dict[str, Any] | None,
    project: dict[str, Any] | None,
    attn: dict[str, Any],
    report_desc: str,
    *,
    work_type: str = "部门工作",
    cost_org: str = "",
    org_id: str = "",
    std_hours_override: float | None = None,
    ovt_hours_override: float | None = None,
) -> dict[str, Any]:
    """提交工时填报 (PM300300 mode=1)。

    Args:
        session: 已登录的 requests.Session。
        cid: CompanyID。
        emp_id: EmpID。
        date: 报工日期 YYYY-MM-DD。
        phase: 阶段信息 dict，含 TaskID/TaskName 等。非项目类传 None。
        project: 项目信息 dict，含 ProjectID/ProjectName 等。非项目类传 None。
        attn: 考勤 dict，含 StdHours/OvtHours/MealTime/AttnTime。
        report_desc: 报工内容（自动追加 BR-Agent 后缀）。
        work_type: 工作类别，如 "部门工作" / "项目工时" / "销售支持"。
        cost_org: 成本部门 ID。非项目类若不传则保持空。
        org_id: 组织 ID。若为空则尝试从 Cookie 获取。
        std_hours_override: 显式指定标准工时（拆分报工时使用），覆盖考勤值。
        ovt_hours_override: 显式指定加班工时（拆分报工时使用），覆盖考勤值。

    Returns:
        接口返回的完整 JSON dict（含 Data[0].DocNo, Data[0].oaflow）。
    """
    if std_hours_override is not None:
        std_hours = std_hours_override
    else:
        std_hours = float(attn.get("StdHours", 0))
    if ovt_hours_override is not None:
        ovt_hours = ovt_hours_override
    else:
        ovt_hours = float(attn.get("OvtHours", 0))
    meal_time = int(float(attn.get("MealTime", 0)))
    attn_time = float(attn.get("AttnTime", 0))
    real_work_time = std_hours + ovt_hours

    if not org_id:
        org_id = session.cookies.get("orgid", "")

    full_desc = f"{report_desc}{_SUFFIX}"

    # ── xmldetails0: 主表 ──
    xml0 = (
        f'<?xml version="1.0" encoding="GBK" ?>'
        f'<ROOT><xmldetail CompanyID="{cid}" DocType="RPT" '
        f'OrgID="{org_id}" EmpID="{emp_id}" ReportDate="{date}" '
        f'CreateUsr="{emp_id}" MealTime="{meal_time}" '
        f'AttnTime="{attn_time}" '
        f'StdWorkTime="{std_hours}" OvtWorkTime="{ovt_hours}" '
        f'RealWorkTime="{real_work_time}"/></ROOT>'
    )

    # ── xmldetails1: 明细 ──
    if is_non_project(work_type):
        # 非项目类：含工作任务（ReportWorkPhase），但项目字段为空
        rwp = phase.get("TaskID", "") if phase else ""
        pn = phase.get("TaskName", "") if phase else ""
        plan_h = (phase.get("PlanHours", "-") if phase else "-")
        have_h = (phase.get("haveRptHours", "0") if phase else "0")
        no_h = (phase.get("noAuditHours", "-") if phase else "-")
        can_h = (phase.get("canRptHours", "0") if phase else "0")
        xml1 = (
            f'<?xml version="1.0" encoding="GBK" ?>'
            f'<ROOT><xmldetail ReportWorkType="{xml_escape(work_type)}" '
            f'ReportWorkPhase="{xml_escape(rwp)}" '
            f'PhaseName="{xml_escape(pn)}" '
            f'PlanHours="{xml_escape(plan_h)}" '
            f'haveRptHours="{xml_escape(have_h)}" '
            f'noAuditHours="{xml_escape(no_h)}" '
            f'canRptHours="{xml_escape(can_h)}" '
            f'AddType="0" CostOrg="{xml_escape(cost_org)}" '
            f'AuditStatus="1" DetailSeq="1" ReportWorkPhaseOptions="" '
            f'StdWorkTime="{std_hours}" RealWorkTime="{real_work_time}" '
            f'OvtWorkTime="{ovt_hours}" '
            f'ReportDesc="{xml_escape(full_desc)}"/></ROOT>'
        )
    else:
        # 项目类：写入完整项目与阶段字段
        rwp = phase.get("TaskID", "") if phase else ""
        pn = phase.get("TaskName", "") if phase else ""
        pid = project.get("ProjectID", "") if project else ""
        pname = project.get("ProjectName", "") if project else ""
        pmgr = project.get("ProjectManager", "") if project else ""
        ptype = project.get("ProjectType", "") if project else ""
        co = cost_org or (project.get("CostOrg", "") if project else "")
        plan_h = (phase.get("PlanHours", "-") if phase else "-")
        have_h = (phase.get("haveRptHours", "0") if phase else "0")
        no_h = (phase.get("noAuditHours", "-") if phase else "-")
        can_h = (phase.get("canRptHours", "0") if phase else "0")

        xml1 = (
            f'<?xml version="1.0" encoding="GBK" ?>'
            f'<ROOT><xmldetail ReportWorkType="{xml_escape(work_type)}" '
            f'ReportWorkPhase="{xml_escape(rwp)}" '
            f'PhaseName="{xml_escape(pn)}" '
            f'ProjectID="{xml_escape(pid)}" '
            f'ProjectName="{xml_escape(pname)}" '
            f'ProjectManager="{xml_escape(pmgr)}" '
            f'PlanHours="{xml_escape(plan_h)}" '
            f'haveRptHours="{xml_escape(have_h)}" '
            f'noAuditHours="{xml_escape(no_h)}" '
            f'canRptHours="{xml_escape(can_h)}" '
            f'AddType="0" CostOrg="{xml_escape(co)}" '
            f'ProjectType="{xml_escape(ptype)}" '
            f'AuditStatus="1" DetailSeq="1" ReportWorkPhaseOptions="" '
            f'StdWorkTime="{std_hours}" RealWorkTime="{real_work_time}" '
            f'OvtWorkTime="{ovt_hours}" '
            f'ReportDesc="{xml_escape(full_desc)}"/></ROOT>'
        )

    # ── 构建参数 ──
    params = {
        "trancode": "PM300300",
        "mode": "1",
        "xmldetails0": xml0,
        "xmldetails1": xml1,
        "SrcCopied": "submit",
        "CompanyID": cid,
        "DocType": "RPT",
        "OrgID": org_id,
        "EmpID": emp_id,
        "ReportDate": date,
        "MealTime": str(meal_time),
        "AttnTime": str(attn_time),
        "LeaveTime": "0",
        "CanStdWorkTime": "0",
        "CanOvtWorkTime": "0",
        "ReportDesc": "",  # 顶层必须为空
        "RealWorkTime": str(real_work_time),
        "_ENCODE_": "UTF-8",
    }

    body = urllib.parse.urlencode(params, doseq=True)
    url = f"{BASE_URL}/oprperform.do"
    resp = session.post(
        url,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        timeout=30,
    )
    data = _bip_assert("提交工时填报", url, resp)
    return data


def submit_approval(session: requests.Session, oaflow: list) -> dict[str, Any]:
    """提交审批 (POST /transfer)。

    Args:
        session: 已登录的 requests.Session。
        oaflow: submit_work_hour 返回的 oaflow 数组。

    Returns:
        接口返回的 JSON dict。
    """
    url = f"{BASE_URL}/transfer"
    resp = session.post(
        url,
        data={
            "transferdata": json.dumps(oaflow, ensure_ascii=False),
            "_ENCODE_": "UTF-8",
        },
        timeout=30,
    )
    return _bip_assert("提交审批", url, resp)


def update_status(session: requests.Session, cid: str, doc_no: str) -> dict[str, Any]:
    """修改状态为审批中 (PM300302 mode=2)。

    前端 calHeader 精确行为：execmode=""，SrcCopied="submit"。

    Args:
        session: 已登录的 requests.Session。
        cid: CompanyID。
        doc_no: submit_work_hour 返回的 DocNo。

    Returns:
        接口返回的 JSON dict。
    """
    url = f"{BASE_URL}/oprperform.do"
    resp = session.post(
        url,
        data={
            "trancode": "PM300302",
            "mode": "2",
            "execmode": "",
            "SrcCopied": "submit",
            "CompanyID": cid,
            "DocNo": doc_no,
            "_ENCODE_": "UTF-8",
        },
        timeout=30,
    )
    return _bip_assert("修改状态", url, resp)


def submit_work_hour_split(
    session: requests.Session,
    cid: str,
    emp_id: str,
    date: str,
    attn: dict[str, Any],
    items: list[dict[str, Any]],
    *,
    org_id: str = "",
) -> dict[str, Any]:
    """拆分报工：单次提交含多条明细行 (PM300300 mode=1)。

    每条明细独立指定 phase/project/content/std_hours/ovt_hours。
    xmldetails0 汇总全部工时，xmldetails1 含多条 <xmldetail>（按 DetailSeq 区分）。

    Args:
        session: 已登录的 requests.Session。
        cid: CompanyID。
        emp_id: EmpID。
        date: 报工日期 YYYY-MM-DD。
        attn: 考勤 dict，用于 MealTime/AttnTime。
        items: 拆分项列表，每项 dict 含:
            - work_type: 工作类别
            - phase: 阶段 dict（含 TaskID/TaskName 等）
            - project: 项目 dict（非项目类为 None）
            - content: 报工内容
            - std_hours: 标准工时 (float)
            - ovt_hours: 加班工时 (float)
            - cost_org: 成本部门 ID（可选，默认 ""）
        org_id: 组织 ID。若为空则尝试从 Cookie 获取。

    Returns:
        接口返回的完整 JSON dict（含 Data[0].DocNo, Data[0].oaflow）。
    """
    if not org_id:
        org_id = session.cookies.get("orgid", "")

    meal_time = int(float(attn.get("MealTime", 0)))
    attn_time = float(attn.get("AttnTime", 0))

    # 汇总工时
    total_std = sum(float(it["std_hours"]) for it in items)
    total_ovt = sum(float(it["ovt_hours"]) for it in items)
    total_real = total_std + total_ovt

    # 自动调整 MealTime：确保 std+ovt+meal ≤ attn_time
    if attn_time > 0 and total_real + meal_time > attn_time:
        old_meal = meal_time
        meal_time = max(0, int(attn_time - total_real))
        if old_meal != meal_time:
            print(f"  ⚠️ 自动调整吃饭时长: {old_meal}h → {meal_time}h (以满足考勤校验)")

    # ── xmldetails0: 主表（汇总工时） ──
    xml0 = (
        f'<?xml version="1.0" encoding="GBK" ?>'
        f'<ROOT><xmldetail CompanyID="{cid}" DocType="RPT" '
        f'OrgID="{org_id}" EmpID="{emp_id}" ReportDate="{date}" '
        f'CreateUsr="{emp_id}" MealTime="{meal_time}" '
        f'AttnTime="{attn_time}" '
        f'StdWorkTime="{total_std}" OvtWorkTime="{total_ovt}" '
        f'RealWorkTime="{total_real}"/></ROOT>'
    )

    # ── xmldetails1: 多条明细 ──
    details_xml_parts: list[str] = []
    for seq, item in enumerate(items, 1):
        work_type = item["work_type"]
        phase = item.get("phase") or {}
        project = item.get("project") or {}
        content = item["content"]
        std_h = float(item["std_hours"])
        ovt_h = float(item["ovt_hours"])
        real_h = std_h + ovt_h
        cost_org = item.get("cost_org", "")
        full_desc = f"{content}{_SUFFIX}"

        rwp = phase.get("TaskID", "")
        pn = phase.get("TaskName", "")
        plan_h = phase.get("PlanHours", "-") if phase else "-"
        have_h = phase.get("haveRptHours", "0") if phase else "0"
        no_h = phase.get("noAuditHours", "-") if phase else "-"
        can_h = phase.get("canRptHours", "0") if phase else "0"

        if is_non_project(work_type):
            detail_xml = (
                f'<xmldetail ReportWorkType="{xml_escape(work_type)}" '
                f'ReportWorkPhase="{xml_escape(rwp)}" '
                f'PhaseName="{xml_escape(pn)}" '
                f'PlanHours="{xml_escape(plan_h)}" '
                f'haveRptHours="{xml_escape(have_h)}" '
                f'noAuditHours="{xml_escape(no_h)}" '
                f'canRptHours="{xml_escape(can_h)}" '
                f'AddType="0" CostOrg="{xml_escape(cost_org)}" '
                f'AuditStatus="1" DetailSeq="{seq}" ReportWorkPhaseOptions="" '
                f'StdWorkTime="{std_h}" RealWorkTime="{real_h}" '
                f'OvtWorkTime="{ovt_h}" '
                f'ReportDesc="{xml_escape(full_desc)}"/>'
            )
        else:
            pid = project.get("ProjectID", "")
            pname = project.get("ProjectName", "")
            pmgr = project.get("ProjectManager", "")
            ptype = project.get("ProjectType", "")
            co = cost_org or project.get("CostOrg", "")
            detail_xml = (
                f'<xmldetail ReportWorkType="{xml_escape(work_type)}" '
                f'ReportWorkPhase="{xml_escape(rwp)}" '
                f'PhaseName="{xml_escape(pn)}" '
                f'ProjectID="{xml_escape(pid)}" '
                f'ProjectName="{xml_escape(pname)}" '
                f'ProjectManager="{xml_escape(pmgr)}" '
                f'PlanHours="{xml_escape(plan_h)}" '
                f'haveRptHours="{xml_escape(have_h)}" '
                f'noAuditHours="{xml_escape(no_h)}" '
                f'canRptHours="{xml_escape(can_h)}" '
                f'AddType="0" CostOrg="{xml_escape(co)}" '
                f'ProjectType="{xml_escape(ptype)}" '
                f'AuditStatus="1" DetailSeq="{seq}" ReportWorkPhaseOptions="" '
                f'StdWorkTime="{std_h}" RealWorkTime="{real_h}" '
                f'OvtWorkTime="{ovt_h}" '
                f'ReportDesc="{xml_escape(full_desc)}"/>'
            )
        details_xml_parts.append(detail_xml)

    xml1 = (
        f'<?xml version="1.0" encoding="GBK" ?>'
        f'<ROOT>{"".join(details_xml_parts)}</ROOT>'
    )

    # ── 构建参数 ──
    params = {
        "trancode": "PM300300",
        "mode": "1",
        "xmldetails0": xml0,
        "xmldetails1": xml1,
        "SrcCopied": "submit",
        "CompanyID": cid,
        "DocType": "RPT",
        "OrgID": org_id,
        "EmpID": emp_id,
        "ReportDate": date,
        "MealTime": str(meal_time),
        "AttnTime": str(attn_time),
        "LeaveTime": "0",
        "CanStdWorkTime": "0",
        "CanOvtWorkTime": "0",
        "ReportDesc": "",
        "RealWorkTime": str(total_real),
        "_ENCODE_": "UTF-8",
    }

    body = urllib.parse.urlencode(params, doseq=True)
    url = f"{BASE_URL}/oprperform.do"
    resp = session.post(
        url,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        timeout=30,
    )
    data = _bip_assert("拆分报工提交", url, resp)
    return data


def delete_report(session: requests.Session, cid: str, doc_no: str) -> dict[str, Any]:
    """删除已有报工记录 (PM300300 mode=3)。"""
    url = f"{BASE_URL}/oprperform.do"
    resp = session.post(
        url,
        data={
            "trancode": "PM300300",
            "mode": "3",
            "execmode": "SrcCopied",
            "CompanyID": cid,
            "DocNo": doc_no,
            "_ENCODE_": "UTF-8",
        },
        timeout=30,
    )
    return _bip_assert("删除报工单", url, resp)


def revoke_report(session: requests.Session, cid: str, doc_no: str) -> dict[str, Any]:
    """撤销/反审核报工单，使其可被删除。

    对应 BIP 前端工时填报页面的「Undo」按钮的完整流程：
      1. PM300300 mode=8, execmode=UnAudit  → 反审核报工单
      2. 若响应含 oaflow → transfer 更新 OA 审批状态为 Revoked
      3. PM300302 mode=2, execmode=UnAudit → 更新明细审批状态
    仅对 AuditStatus=4（审批中）的记录有效。
    审批通过(8)不可撤销，已撤销(2)/待提交(1)/反审核(16)也无需撤销。
    撤销成功后该记录可被 delete_report() 删除。
    """
    url = f"{BASE_URL}/oprperform.do"

    # 第一步：反审核
    unaudit_resp = session.post(
        url,
        data={
            "trancode": "PM300300",
            "mode": "8",
            "execmode": "UnAudit",
            "CompanyID": cid,
            "DocType": "RPT",
            "DocNo": doc_no,
            "_ENCODE_": "UTF-8",
        },
        timeout=30,
    )
    unaudit_data = _bip_assert("撤销审批", url, unaudit_resp)

    # 第二步：如果响应中包含 oaflow，通过 transfer 更新 OA 审批状态为 Revoked
    # 前端逻辑：e.oprPerform(...).then(a => { if (a[0]?.oaflow) { e.$api.transfer(...) } })
    try:
        unaudit_json = unaudit_resp.json()
        data_list = unaudit_json.get("Data", [])
        if isinstance(data_list, list) and len(data_list) > 0:
            oaflow = data_list[0].get("oaflow")
            if oaflow and isinstance(oaflow, list):
                user_id = session.cookies.get("userid", "")
                transfer_list = []
                for item in oaflow:
                    raw_param = item.get("param", {})
                    # 深拷贝 param（对应前端 JSON.parse(JSON.stringify(param))）
                    param = json.loads(json.dumps(raw_param, ensure_ascii=False))
                    # 仅当 param 是 dict 时添加 UserID（字符串 param 如 "Rmrk=撤回" 则保持原样）
                    if isinstance(param, dict) and user_id:
                        param["UserID"] = user_id
                    transfer_list.append({
                        "url": item.get("url", ""),
                        "param": param,
                    })
                if transfer_list:
                    transfer_url = f"{BASE_URL}/transfer"
                    _bip_assert("更新OA审批状态", transfer_url, session.post(
                        transfer_url,
                        data={
                            "transferdata": json.dumps(transfer_list, ensure_ascii=False),
                            "_ENCODE_": "UTF-8",
                        },
                        timeout=30,
                    ))
    except Exception:
        # oaflow 处理失败不阻断主流程，仅记录警告
        print("  ⚠️ OA 审批状态更新失败（不影响撤销结果）", file=sys.stderr)

    # 第三步：更新明细状态（对应前端 calHeader）
    return _bip_assert("更新明细状态", url, session.post(
        url,
        data={
            "trancode": "PM300302",
            "mode": "2",
            "execmode": "UnAudit",
            "CompanyID": cid,
            "DocNo": doc_no,
            "_ENCODE_": "UTF-8",
        },
        timeout=30,
    ))
