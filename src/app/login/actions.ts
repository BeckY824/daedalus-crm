"use server";

import bcrypt from "bcryptjs";
import { headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { createSession } from "@/lib/auth";
import { 检查限流, 记一次失败, 清除限流, 解析来源IP, 阈值, IP阈值 } from "@/lib/rate-limit";

export type LoginResult = { ok: true } | { ok: false; error: string };

/**
 * 限流的 key 同时按「账号」和「来源 IP」记。
 * 只按账号：换个账号名就绕过了；只按 IP：同一办公室的人会互相牵连。
 * 两个都记，任一触发即拒绝。
 *
 * **取 X-Forwarded-For 的最后一段，不是第一段。**
 * XFF 是一条链：`客户端自称的, 上游代理看到的, ..., 最近一跳看到的`。
 * 前面几段都是客户端能自己伪造的——取第一段的话，攻击者每次换个假 IP
 * 就换一个桶，IP 档的上限形同虚设，还能用假 IP 把内存里的 Map 无限撑大。
 * 最后一段是紧邻的反代（这里是 Caddy）自己拼上去的，伪造不了。
 *
 * 没有反代直连时不会有这个头，返回 null，此时只按账号限流——
 * 那种情况下任何 IP 都是客户端说了算，按它限流没有意义。
 */
async function 来源IP(): Promise<string | null> {
  const h = await headers();
  return 解析来源IP(h.get("x-forwarded-for"));
}

export async function login(email: string, password: string): Promise<LoginResult> {
  const 账号 = email.trim().toLowerCase();
  const ip = await 来源IP();
  /**
   * 两档阈值，因为误伤代价不同：
   *   按账号 —— 严（5 次），误伤只落在打错密码的本人头上
   *   按 IP  —— 松（30 次），整个办公室共用一个出口 IP，
   *             定严了会变成「一个同事手滑，全公司登不上」
   * 拿不到 IP 时干脆不按 IP 限，否则所有请求挤进同一个桶，后果同上。
   */
  const keys: [string, number][] = [[`u:${账号}`, 阈值]];
  if (ip) keys.push([`ip:${ip}`, IP阈值]);

  for (const [k] of keys) {
    const 还要等 = 检查限流(k);
    if (还要等 != null) {
      const 分 = Math.ceil(还要等 / 60);
      return { ok: false, error: `登录失败次数过多，请 ${分} 分钟后再试` };
    }
  }

  const user = await prisma.user.findUnique({ where: { email: 账号 } });

  if (!user || !user.active) {
    keys.forEach(([k, 上限]) => 记一次失败(k, Date.now(), 上限));
    return { ok: false, error: "账号不存在或已停用" };
  }

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    keys.forEach(([k, 上限]) => 记一次失败(k, Date.now(), 上限));
    return { ok: false, error: "密码错误" };
  }

  keys.forEach(([k]) => 清除限流(k));
  await createSession(user.id);
  return { ok: true };
}
