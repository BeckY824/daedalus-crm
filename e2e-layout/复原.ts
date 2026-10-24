/**
 * 排版闸门几份用例共用一个库（workers 1，按文件名排序跑）。往库里灌了数据的那份，测完自己删掉；
 * 不靠前后顺序的那份（比如「我的反馈」），开头先删一遍，保证自己看到的是「没有闸门数据」的库。
 *
 * 10-22：#86（图片）、#87（商机管道）的文件名排在「我的反馈」前面，留下的客户把客户列表撑出分页，
 * 分页条跟左下角的反馈提示叠在一起，「我的反馈」就红了。真实的叠放交给桌面端修，这里只管用例互不影响。
 *
 * 只删 id 以 gate- 开头的：种子.ts、各用例自己造的都用这个前缀。客户删了，挂在下面的商机、订单、跟进、计划一起没。
 * 业务模版不在这里切回去：闸门起服务前就写好外贸 + 长选项（长选项.ts），再点一次预设会把长选项盖掉
 */
import { 连库 } from "../e2e-desktop/helpers";

export async function 清闸门数据() {
  const db = 连库();
  try {
    // 图片表没有外键（#86 起才有这张表），先按商机 / 订单号删；没有这张表就跳过
    const [表] = await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'Attachment'`);
    if (Number(表?.n)) await db.$executeRawUnsafe(`DELETE FROM "Attachment" WHERE "opportunityId" LIKE 'gate-%' OR "orderId" LIKE 'gate-%'`);
    await db.opportunity.deleteMany({ where: { id: { startsWith: "gate-" } } });
    await db.customer.deleteMany({ where: { id: { startsWith: "gate-" } } });
    await db.supplier.deleteMany({ where: { id: { startsWith: "gate-" } } });
    // 同事最后删：他们名下的商机、客户上面已经删了
    await db.user.deleteMany({ where: { id: { startsWith: "gate-" } } });
  } finally {
    await db.$disconnect();
  }
}
