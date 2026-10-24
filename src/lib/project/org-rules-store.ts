/** 组织规则的读写（只在服务端用；规整和类型在 org-rules.ts，界面能引那份） */
import { getSetting, setSetting } from "../settings";
import { 规整组织规则, type 组织规则 } from "./org-rules";

export async function 读组织规则(): Promise<组织规则> {
  return 规整组织规则(await getSetting("orgRules"));
}

export async function 存组织规则(规则: 组织规则): Promise<void> {
  await setSetting("orgRules", 规整组织规则(规则));
}
