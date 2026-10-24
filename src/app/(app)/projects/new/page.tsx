import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getBusiness } from "@/lib/business";
import { 负责人候选 } from "@/lib/owners";
import { 生效组织规则 } from "@/lib/project/org-rules-store";
import ProjectWizard from "./ProjectWizard";

export const dynamic = "force-dynamic";

/** 建档向导（项目模式 1a）。开关关着时不存在 */
export default async function NewProjectPage() {
  await requireUser();
  if ((await getBusiness()).projectMode !== true) notFound();
  // 企业版开了超时回收：首条沟通要填下一步时间（lib/project/wizard.ts 规整向导 也拦）
  const [users, 规则] = await Promise.all([负责人候选(), 生效组织规则()]);
  return <ProjectWizard users={users} 要下一步={规则.超时回收.开} />;
}
