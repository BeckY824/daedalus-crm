import { prisma } from "./prisma";
import { 可担任负责人 } from "./constants";

/**
 * 「谁能被指派为负责人」的候选名单。
 *
 * 默认口径是排除系统管理员（见 constants.ts 里 可担任负责人 的说明）——
 * 管理员只做系统维护，业绩排行榜也不算他们的。
 *
 * 但这条规则在「整个工作区只有一个人，而那个人是管理员」时会把产品卡死：
 * 负责人是必填项，下拉却是空的，新注册的人连第一条客户都建不出来。
 * 托管版每个新工作区一开始都正好是这个状态。
 *
 * 所以这里留一个回退：没有任何非管理员可选时，列出全部在职成员。
 * 「管理员不当负责人」是一种偏好，不是不变量；没有别人时它必须让路。
 *
 * 回退只用于**指派下拉**。业绩排行榜仍按严格口径，不然管理员自己给自己
 * 派了客户就会出现在排行榜上，两套数字又对不上了。
 */
export async function 负责人候选() {
  const 选项 = { select: { id: true, name: true, email: true }, orderBy: { name: "asc" as const } };
  const 非管理员 = await prisma.user.findMany({ where: 可担任负责人, ...选项 });
  if (非管理员.length > 0) return 非管理员;
  return prisma.user.findMany({ where: { active: true }, ...选项 });
}
