import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getBusiness } from "@/lib/business";
import { 负责人候选 } from "@/lib/owners";
import { 生效组织规则 } from "@/lib/project/org-rules-store";
import { 企业版 } from "@/lib/enterprise/switch";
import ProjectWizard from "./ProjectWizard";

export const dynamic = "force-dynamic";

/** 建档向导（项目模式 1a）。开关关着时不存在 */
export default async function NewProjectPage() {
  await requireUser();
  if ((await getBusiness()).projectMode !== true) notFound();
  // 企业版开了超时回收：首条沟通要填下一步时间（lib/project/wizard.ts 规整向导 也拦）
  const [users, 规则] = await Promise.all([负责人候选(), 生效组织规则()]);
  // 企业版：第一步先选号码类型、按类型验格式、全公司查重（customers/number-actions.ts）
  return <ProjectWizard users={users} 要下一步={规则.超时回收.开} 企业版={企业版()} />;
}
