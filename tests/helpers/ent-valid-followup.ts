/**
 * 企业版三大阶段测试共用：给项目记一条「客户明确回复了」的有效沟通（直接写库，跳过记沟通的校验）。
 * 线索阶段越过「线索验证」往前推要先有一条（lib/project/stage-gates.ts 企业版推进关）。
 */
import { prisma } from "@/lib/prisma";

export async function 记有效沟通(projectId: string, replied = true, phase = "线索"): Promise<string> {
  const p = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { customerId: true, ownerId: true, node: true } });
  const f = await prisma.followUp.create({ data: { type: "PHONE", title: "沟通", content: "聊了", customerId: p.customerId, ownerId: p.ownerId } });
  await prisma.followUpProject.create({ data: { followUpId: f.id, projectId, node: p.node } });
  await prisma.entFollowUpMark.create({ data: { followUpId: f.id, projectId, phase, replied } });
  return f.id;
}
