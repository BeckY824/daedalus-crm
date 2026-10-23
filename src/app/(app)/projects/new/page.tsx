import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { getBusiness } from "@/lib/business";
import { 负责人候选 } from "@/lib/owners";
import ProjectWizard from "./ProjectWizard";

export const dynamic = "force-dynamic";

/** 建档向导（项目模式 1a）。开关关着时不存在 */
export default async function NewProjectPage() {
  await requireUser();
  if ((await getBusiness()).projectMode !== true) notFound();
  return <ProjectWizard users={await 负责人候选()} />;
}
