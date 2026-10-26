import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getBusiness } from "@/lib/business";
import { 负责人候选 } from "@/lib/owners";
import { 生效组织规则 } from "@/lib/project/org-rules-store";
import { 企业版 } from "@/lib/enterprise/switch";
import { 企业版字典 } from "@/lib/project/nodes";
import { prisma } from "@/lib/prisma";
import ProjectWizard from "./ProjectWizard";

export const dynamic = "force-dynamic";

/** 建档向导（项目模式 1a）。开关关着时不存在 */
export default async function NewProjectPage() {
  await requireUser();
  if ((await getBusiness()).projectMode !== true) notFound();
  // 企业版开了超时回收：首条沟通要填下一步时间（lib/project/wizard.ts 规整向导 也拦）
  const [users, 规则] = await Promise.all([负责人候选(), 生效组织规则()]);
  // 企业版新建线索：渠道、负责人、跟进节点、客户是否明确回复必选（lib/project/wizard.ts 规整向导 + 建档向导 也拦）
  const 企业 = 企业版()
    ? { 渠道们: await prisma.channel.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" } }), 节点们: 企业版字典.节点们.线索 }
    : null;
  return <ProjectWizard users={users} 要下一步={规则.超时回收.开} 企业={企业} />;
}
