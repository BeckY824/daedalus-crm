import { control } from "./control";
import { 运营名单 } from "@/lib/ops-auth";

/**
 * 测试账号（2026-10-04）。用户原话：「测试用的账号 AI 不限次数，也不计算到注册用户和（活跃用户）。
 * 在检测中显示测试用户即可，不算真实用户与活跃用户。」
 *
 * 一个账号是测试账号，满足其一即可：
 *   1. 运营台上标过（TestAccount 表里 on = true）
 *   2. **它是运营账号**——邮箱或手机号在 OPS_ACCOUNTS 里。那是我们自己的号，天天点来点去，
 *      算进注册数 / 活跃数只会把数抬高，扣它的次数也只是给自己设卡。所以默认就当测试账号，不用再去标；
 *      从名单里拿掉，它就回到普通账号（运营台上标过的另算）
 *
 * 测试账号意味着三件事，各自在用的地方判：
 *   - AI 不限次数：lib/tenant/credits.ts 的 按问题扣一次 / 余额（账号这一路；工作区那一路不看这个）
 *   - 运营台的统计一律排除：app/admin/data.ts、app/admin/usage、lib/tenant/ai-cost.ts 的 成本概览
 *   - 不触发运营通知：lib/ops-notices.ts（新注册、用量异常）
 * 调用照样记进 AiCall——「用量仍然记录，方便我们看」，只是不进统计。
 */

export type 测试来由 = "标的" | "运营";

/** 联系方式在不在运营名单里。和 lib/ops-auth.ts 的 是运营账号 同一个口径（不看停没停用：停了也还是我们的号） */
function 在运营名单(a: { email: string | null; phone: string | null }, 名单: string[]): boolean {
  return [a.email, a.phone].some((x) => x && 名单.includes(x.toLowerCase()));
}

/**
 * 所有测试账号：id → 为什么算。运营台一次取全，拿来排除统计、给列表打标签。
 * 运营台标过、同时又是运营账号的，记「标的」——取消标记之后它仍然是测试账号（因为是运营），界面上要说得清
 */
export async function 测试账号们(env: Record<string, string | undefined> = process.env): Promise<Map<string, 测试来由>> {
  const 名单 = 运营名单(env);
  const [标的, 运营们] = await Promise.all([
    control.testAccount.findMany({ where: { on: true }, select: { accountId: true } }),
    名单.length
      ? control.account.findMany({
          where: { OR: [{ email: { in: 名单 } }, { phone: { in: 名单 } }] },
          select: { id: true, email: true, phone: true },
        })
      : Promise.resolve([] as { id: string; email: string | null; phone: string | null }[]),
  ]);
  const 出 = new Map<string, 测试来由>();
  for (const a of 运营们) if (在运营名单(a, 名单)) 出.set(a.id, "运营");
  for (const t of 标的) 出.set(t.accountId, "标的");
  return 出;
}

/**
 * 这一个账号是不是测试账号。网关每次调用都会问一次：一次主键查询，不是运营账号时再一次。
 * **查不动就当不是**——宁可照常扣次数，也不要因为库抖了一下变成不限次
 */
export async function 是测试账号(accountId: string, env: Record<string, string | undefined> = process.env): Promise<boolean> {
  try {
    const t = await control.testAccount.findUnique({ where: { accountId }, select: { on: true } });
    if (t?.on) return true;
    const 名单 = 运营名单(env);
    if (名单.length === 0) return false;
    const a = await control.account.findUnique({ where: { id: accountId }, select: { email: true, phone: true } });
    return Boolean(a && 在运营名单(a, 名单));
  } catch (e) {
    console.warn("[test-accounts] 查不动，按普通账号算：", e instanceof Error ? e.message : e);
    return false;
  }
}

/** 留痕的一行。时间按本机时区（线上 TZ=Asia/Shanghai），和运营台别处一个口径 */
export function 留痕行(on: boolean, by: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const 时 = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}`;
  return `${时} ${on ? "标为测试账号" : "取消测试账号"} · ${by}`;
}

/**
 * 标成 / 取消测试账号。返回 false = 本来就是这样，没动（也不多记一行留痕）。
 * 取消不删行：只把 on 置成 false，log 往后追一行——谁、什么时候改的都留着。
 */
export async function 设测试账号(accountId: string, on: boolean, by: string, now = new Date()): Promise<boolean> {
  const 有 = await control.testAccount.findUnique({ where: { accountId } });
  if ((有?.on ?? false) === on) return false;
  const 行 = 留痕行(on, by, now);
  await control.testAccount.upsert({
    where: { accountId },
    create: { accountId, on, log: 行, updatedAt: now },
    update: { on, log: 有?.log ? `${有.log}\n${行}` : 行, updatedAt: now },
  });
  return true;
}

/** 一个账号的留痕，新的在前。没标过就是空的 */
export async function 测试留痕(accountId: string): Promise<string[]> {
  const t = await control.testAccount.findUnique({ where: { accountId }, select: { log: true } });
  return (t?.log ?? "").split("\n").filter(Boolean).reverse();
}
