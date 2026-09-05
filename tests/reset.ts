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
  await prisma.setting.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.task.deleteMany();
  await prisma.followPlan.deleteMany();
  await prisma.followUp.deleteMany();
  await prisma.contract.deleteMany();
  await prisma.opportunity.deleteMany();
  await prisma.contact.deleteMany();
  await prisma.lead.deleteMany();
  // 自引用先断开，否则删学员时互相牵制
  await prisma.customer.updateMany({
    data: { referrerCustomerId: null, attributionCustomerId: null },
  });
  await prisma.customer.deleteMany();
  await prisma.channel.deleteMany();
  await prisma.user.deleteMany();
}
