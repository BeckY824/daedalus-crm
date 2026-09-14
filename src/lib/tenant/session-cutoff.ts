/**
 * 改密之后，旧会话该不该继续认。
 *
 * 会话是一张签了 7 天的 JWT，签出去就收不回来——服务端不存它，也就没法删它。
 * 于是「找回密码」如果只换密码，拿着旧 Cookie 的那个人（可能正是把你挤出去的那个）
 * 还能再用 7 天：锁换了，门没换。
 *
 * 补法是给每个改过密码的账号记一条线，票据的签发时刻早于这条线就不认。
 * 代价是每次读当前用户多一次控制面查询——一张主键表的单行查，
 * 而那条路上本来就要查工作区和成员关系，多这一次不值得为它引缓存
 * （引了就得回答「两个容器怎么同步」，而我们不想被这个问题绑住）。
 */

import { control } from "./control";

/** 秒。JWT 的 iat 只有秒，两边都按秒比，避免毫秒精度带来的自己杀自己 */
function 秒(d: Date): number {
  return Math.floor(d.getTime() / 1000);
}

/**
 * 记一次改密。之前签出去的会话从此不认。
 *
 * 存的是「这一刻」，比较时严格小于——同一秒内签出来的新会话要活下来
 * （改完密码立刻登录、甚至就地续一张票，都落在同一秒里）。
 */
export async function 记一次改密(accountId: string, now = new Date()): Promise<void> {
  const since = new Date(秒(now) * 1000);
  await control.sessionCutoff.upsert({
    where: { accountId },
    create: { accountId, since },
    update: { since },
  });
}

/**
 * 这张票还认吗。
 *
 * 没改过密码的账号（绝大多数）查不到行，直接放行。
 * 改过而票据没有 iat 的，当作旧票拒掉——jose 签的票一定带 iat，
 * 没有只可能是别处伪造或格式变了，此时宁可让人重登一次。
 */
export async function 会话已作废(accountId: string, iat: number | undefined, now = new Date()): Promise<boolean> {
  const row = await control.sessionCutoff.findUnique({ where: { accountId } });
  if (!row) return false;
  // 线在未来（时钟回拨、手工改库）时不拿它杀人：那会把所有人挡在门外
  const 线 = Math.min(秒(row.since), 秒(now));
  if (iat == null) return true;
  return iat < 线;
}
