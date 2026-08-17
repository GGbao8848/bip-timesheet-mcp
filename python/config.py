"""BIP 工时填报 - 配置模块。"""

from __future__ import annotations

# 服务器地址
BASE_URL = "http://10.10.10.247/powerbip"

# 登录加密
AES_KEY = b"Test-AES-CBC-128"
AES_IV = b"1234567890123456"

# 公司
COMPANY_ID = "BRS1"

# 考勤默认值（无记录时使用）
DEFAULT_STD_HOURS = "8"
DEFAULT_OVT_HOURS = "0"
DEFAULT_MEAL_TIME = "1"
DEFAULT_ATTN_TIME = "8"

# 考勤扫描
SCAN_DAYS = 30

# 工作类别 → API 内部编码
WORK_TYPE_CODE = {
    "部门工作": "bm",
    "项目工时": "xm",
    "销售支持": "xs",
}

# 审批状态码 → 中文显示
AUDIT_STATUS_MAP = {
    "1": "待提交",
    "2": "已撤销",
    "32": "已驳回",
    "4": "审批中",
    "8": "审批通过",
    "16": "反审核",
}
