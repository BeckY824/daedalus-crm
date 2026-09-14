/**
 * 演示区的访客额度：按**浏览器**记，不按账号。
 *
 * 演示区是所有访客共用的一个工作区，进门不要账号也不要密码，于是「人」只能用 cookie 认。
 * 这件事原来是「演示码」在做（运营台批量生成、一码一人、绑一个浏览器），
 * 整套码 2026-09-15 下线之后，码没了，**按人计数这件事必须留着**——
 * 去掉它演示区就是一个所有人共用、不限次的账单黑洞（那个工作区为了永不过期
 * 被标成了付费态，会被额度那条路当付费客户直接放行）。
 *
 * 清掉 cookie 就能换一份新额度，这是知道的：演示区用最便宜的模型、一人 5 次，
 * 为堵这个口子引指纹或要登录，代价比它防住的大。
 */

import { control } from "./control";

export const 演示对话上限 = 5;

/** 记下这个浏览器进过演示区。重复进入不清零——那等于每刷新一次就送 5 次 */
export async function 进入演示区(visitorId: string): Promise<void> {
  await control.demoVisitor.upsert({
    where: { id: visitorId },
    create: { id: visitorId },
    update: {},
  });
}

/** 这个浏览器进过吗、还剩几次。没进过返回 null */
export async function 演示剩余(visitorId: string): Promise<{ 用掉: number; 还剩: number } | null> {
  const v = await control.demoVisitor.findUnique({ where: { id: visitorId } });
  if (!v) return null;
  return { 用掉: Math.min(v.calls, 演示对话上限), 还剩: Math.max(0, 演示对话上限 - v.calls) };
}

/**
 * 扣一次。
 *
 * 自增和读取必须是**同一次**操作。原来那版是先 updateMany 自增、再查一遍——
 * 两步之间别的请求也在自增，于是每个请求读到的都是最终值：五次额度、十二个并发请求时
 * 十二个都读到 12，一次都不放行。方向是安全的（只会拦多不会漏放），
 * 但对着演示区猛点几下的人就被莫名其妙挡在外面了。
 * update 作用在主键上，返回的就是这一次自增之后的值。
 */
export async function 演示扣一次(visitorId: string): Promise<{ ok: true; 还剩: number } | { ok: false; error: string }> {
  let v;
  try {
    v = await control.demoVisitor.update({ where: { id: visitorId }, data: { calls: { increment: 1 } } });
  } catch {
    return { ok: false, error: "请先从 /demo 进入演示区" };
  }
  if (v.calls > 演示对话上限) {
    // 拦下的这一次要还回去，否则被拦十次之后就再也回不来了
    await control.demoVisitor.update({ where: { id: visitorId }, data: { calls: { decrement: 1 } } }).catch(() => {});
    return { ok: false, error: `演示区每个人可以问 ${演示对话上限} 次，已经用完了。想接着用就注册一个自己的工作区，注册再送一批。` };
  }
  return { ok: true, 还剩: 演示对话上限 - v.calls };
}
