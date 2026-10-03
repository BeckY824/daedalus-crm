/**
 * 新用户注册登录之后先选模版（2026-10-03 用户：「新用户注册登录之后可以选模版那种。目前我们应该只有通用模版，以及外贸模版」）。
 *
 * 只对**桌面端的新库**弹：没选过、没存过业务配置、一条业务数据都没有。老用户升级上来不弹——
 * 他的措辞早定了，模版按他存的来源推断（business-config.ts 的 推断模版），要换去「设置 → 业务配置」。
 * 网页版（托管 / 自部署）不弹：那边是团队共用的库，改模版是管理员在设置里的事。
 */
import { prisma } from "./prisma";
import { getSetting } from "./settings";
import { BUSINESS_KEY } from "./business-config";
import { 本地模式 } from "./desktop/cloud";

export const 选过模版键 = "onboarding.templateChosenAt";

export async function 要选模版(): Promise<boolean> {
  if (!本地模式()) return false;
  if (await getSetting(选过模版键)) return false;
  if (await getSetting(BUSINESS_KEY)) return false;
  const [customers, leads, channels, opportunities] = await Promise.all([
    prisma.customer.count(),
    prisma.lead.count(),
    prisma.channel.count(),
    prisma.opportunity.count(),
  ]);
  return customers + leads + channels + opportunities === 0;
}
