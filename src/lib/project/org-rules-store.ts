/** 组织规则的读写（只在服务端用；规整和类型在 org-rules.ts，界面能引那份） */
import { getSetting, setSetting } from "../settings";
import { 企业版 } from "../enterprise/switch";
import { 规整组织规则, type 组织规则 } from "./org-rules";

export async function 读组织规则(): Promise<组织规则> {
  return 规整组织规则(await getSetting("orgRules"));
}

/**
 * 拦人、回收、必填时用的规则：不是企业版（CRM_ENTERPRISE 不设）就当每条都关，Setting 里存着什么都不算。
 * 设置页显示、改规则合并时用上面的 读组织规则
 */
export async function 生效组织规则(): Promise<组织规则> {
  return 企业版() ? 读组织规则() : 规整组织规则(null);
}

export async function 存组织规则(规则: 组织规则): Promise<void> {
  await setSetting("orgRules", 规整组织规则(规则));
}
