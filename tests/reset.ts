/**
 * 清空测试库。
 *
 * 顺序是有讲究的：先删指向别人的，再删被指向的，否则外键会挡住。
 * 学员表要先把自引用（推荐人、归属）置空才删得掉——它自己指自己。
 *
 * 抽出来是因为原本每个测试文件各写一份，漏一张表就会在
 * 「和别的文件一起跑」时炸在外键上，单独跑却是绿的，很难看出是清库的问题。
 * 加了新表就改这一处。
 */
import { prisma } from "@/lib/prisma";

export async function resetDb() {
  // 对话与消息（消息随对话级联删，先删对话就够；项目单列）
  await prisma.aiConversation.deleteMany();
  await prisma.aiProject.deleteMany();
  await prisma.setting.deleteMany();
  await prisma.auditLog.deleteMany();
  // 导入批次（ImportRow 随批次级联删）
  await prisma.importBatch.deleteMany();
  // 企业版数据接入（EntImportRow 随批次级联删；其余不挂外键，各自清）
  await prisma.entImportBatch.deleteMany();
  await prisma.entExternalRef.deleteMany();
  await prisma.entConflict.deleteMany();
  await prisma.entTrash.deleteMany();
  await prisma.entSnapshot.deleteMany();
  await prisma.task.deleteMany();
  await prisma.followPlan.deleteMany();
  await prisma.followUpSource.deleteMany();
  await prisma.followUp.deleteMany();
  // 附件不建外键（商机删了能撤销），不会被级联带走（2026-10-22 D-24）
  await prisma.attachment.deleteMany();
  await prisma.contract.deleteMany();
  await prisma.opportunity.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.unassignedContact.deleteMany();
  await prisma.lead.deleteMany();
  await prisma.customerPool.deleteMany();
  await prisma.customerClaim.deleteMany();
  // 自引用先断开，否则删学员时互相牵制
  await prisma.customer.updateMany({
    data: { referrerCustomerId: null, attributionCustomerId: null },
  });
  await prisma.customer.deleteMany();
  // 项目、组员、节点变更随客户级联；组员角色、异常类别字典不挂客户，单独清（2026-10-23）
  await prisma.projectRole.deleteMany();
  await prisma.projectExceptionCategory.deleteMany();
  await prisma.channel.deleteMany();
  // 供应商不挂在客户和人下面，不会被级联带走（2026-10-03 加；比价、订单采购随它和商机 / 订单级联）
  await prisma.supplier.deleteMany();
  // 企业版组织架构（迁移 044）：不建外键，不会被级联带走（2026-10-24）
  await prisma.entMember.deleteMany();
  await prisma.entLeadAssign.deleteMany();
  await prisma.entLeadQuota.deleteMany();
  await prisma.entFollowUpMark.deleteMany();
  await prisma.entDept.deleteMany();
  await prisma.user.deleteMany();
}
