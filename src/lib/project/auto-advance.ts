/**
 * 企业版节点必填（D-37）：保存后项目自动往前推了，记操作日志、刷新页面。
 * 推进本身在 lib/project/db.ts 的 按必填推进；这里给项目页、客户页的写共用（不放 "use server" 文件里，免得被当成能直接调的动作）
 */
import { revalidatePath } from "next/cache";
import { prisma } from "../prisma";
import { recordAudit, type Actor } from "../audit";
import { getBusiness } from "../business";
import { 企业版 } from "../enterprise/switch";
import { 客户项目按必填推进 } from "./db";

export async function 记自动推进(me: Actor, 项目们: { id: string; name: string; 到: string[] }[]) {
  for (const p of 项目们) {
    if (!p.到.length) continue;
    await recordAudit({
      user: me, action: "update", entity: "Project", entityId: p.id,
      summary: `项目「${p.name}」必填齐了，自动推进到 ${p.到.join(" → ")}`,
      detail: { 推到: p.到 },
    });
  }
}

export async function 记这个项目的自动推进(me: Actor, projectId: string, 到?: string[]) {
  if (!到?.length) return;
  const p = await prisma.project.findUnique({ where: { id: projectId }, select: { name: true } });
  await 记自动推进(me, [{ id: projectId, name: p?.name ?? "", 到 }]);
}

/**
 * 客户这边存了东西（客户资料、联系人、客户上的跟进）之后调：客户名下齐了的项目往前推、记日志、刷新项目页。
 * 不是企业版、项目模式没开：直接回，不查库。出错不影响客户那边已经存好的
 */
export async function 客户存了推项目(me: Actor, customerId: string | null | undefined) {
  if (!customerId || !企业版()) return;
  try {
    if ((await getBusiness()).projectMode !== true) return;
    const 推了 = await 客户项目按必填推进(me, customerId);
    if (!推了.length) return;
    await 记自动推进(me, 推了);
    revalidatePath("/projects");
    for (const p of 推了) revalidatePath(`/projects/${p.id}`);
  } catch (e) {
    console.error("[节点必填] 客户存了之后推项目失败", e);
  }
}
