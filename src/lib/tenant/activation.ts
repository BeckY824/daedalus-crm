import { randomInt } from "node:crypto";
import { control } from "./control";

/**
 * 试用激活码。
 *
 * 为什么用它而不是短信/邮件验证码：验证码要一条发码通道，短信签名要备案、
 * 邮件还没接；而激活码本身就是授权凭证——码是我们发出去的，拿到码的人就是我们
 * 允许开号的人，注册页不再需要证明"这个手机号是你的"。
 *
 * 字母表去掉 0/O/1/I/l 这类打电话念出来会混的字符；12 位从 31 个字符里取，
 * 约 2^59 种组合，猜不出来。存的是归一化形式（大写、无横线），
 * 人怎么输都行：小写、带空格、带横线，都先归一化再查。
 */
const 字母表 = "ABCDEFGHJKLMNPQRSTUVWXYZ2345679";
export const 激活码长度 = 12;

export function 生成一个(): string {
  let s = "";
  for (let i = 0; i < 激活码长度; i++) s += 字母表[randomInt(字母表.length)];
  return s;
}

/** 给人看的形式：XXXX-XXXX-XXXX */
export function 展示(code: string): string {
  return code.match(/.{1,4}/g)?.join("-") ?? code;
}

/** 人输入的任何写法 → 库里的形式。不合法返回 null */
export function 归一化(input: string): string | null {
  const s = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (s.length !== 激活码长度) return null;
  for (const ch of s) if (!字母表.includes(ch)) return null;
  return s;
}

/** 批量生成并入库。主键冲突的概率可忽略，但真撞上就重生成那一个 */
export async function 生成并入库(count: number, note?: string): Promise<string[]> {
  const n = Math.max(1, Math.min(100, Math.floor(count)));
  const out: string[] = [];
  while (out.length < n) {
    const code = 生成一个();
    try {
      await control.activationCode.create({ data: { code, note: note?.trim() || null } });
      out.push(code);
    } catch {
      /* 撞了主键，换一个 */
    }
  }
  return out;
}

/**
 * 原子占用：只有 usedAt 还是空的那一行能被改成非空，updateMany 影响 0 行就是
 * 没占到（不存在、或被别人先用了）。不先查再写——两个人同时提交同一个码时，
 * 先查再写会让两个人都通过。
 */
export async function 占用(raw: string, accountId: string): Promise<{ ok: true; code: string } | { ok: false; error: string }> {
  const code = 归一化(raw);
  if (!code) return { ok: false, error: "激活码格式不对：12 位，形如 XXXX-XXXX-XXXX" };
  const r = await control.activationCode.updateMany({
    where: { code, usedAt: null },
    data: { usedAt: new Date(), usedBy: accountId },
  });
  if (r.count !== 1) return { ok: false, error: "激活码无效或已被使用" };
  return { ok: true, code };
}

/** 开号失败时把码还回去，别让人白丢一个码 */
export async function 释放(code: string): Promise<void> {
  await control.activationCode.updateMany({ where: { code }, data: { usedAt: null, usedBy: null, workspaceId: null } });
}

export async function 记工作区(code: string, workspaceId: string): Promise<void> {
  await control.activationCode.update({ where: { code }, data: { workspaceId } });
}

/* ---------- 演示码：一码一人，绑 cookie，5 次 AI ---------- */

export const 演示对话上限 = 5;

export async function 生成演示码(count: number, note?: string): Promise<string[]> {
  const n = Math.max(1, Math.min(100, Math.floor(count)));
  const out: string[] = [];
  while (out.length < n) {
    const code = 生成一个();
    try {
      await control.demoCode.create({ data: { code, note: note?.trim() || null } });
      out.push(code);
    } catch {
      /* 撞了主键，换一个 */
    }
  }
  return out;
}

/**
 * 把演示码绑到一个访客（cookie 里的 id）。
 * 原子：只有 boundVisitor 还是空的那一行能被绑上；同一个访客重复提交同一个码算成功
 * （刷新页面、重新进入都不该把人拦在外面）。别的浏览器拿同一个码来 → 拒。
 */
export async function 绑定演示码(raw: string, visitorId: string): Promise<{ ok: true; code: string } | { ok: false; error: string }> {
  const code = 归一化(raw);
  if (!code) return { ok: false, error: "演示码格式不对：12 位，形如 XXXX-XXXX-XXXX" };
  const r = await control.demoCode.updateMany({
    where: { code, boundVisitor: null },
    data: { boundVisitor: visitorId, boundAt: new Date() },
  });
  if (r.count === 1) return { ok: true, code };
  const mine = await control.demoCode.findFirst({ where: { code, boundVisitor: visitorId }, select: { code: true } });
  if (mine) return { ok: true, code };
  return { ok: false, error: "演示码无效或已在别的浏览器使用" };
}

/** 这个访客绑过码吗、还剩几次。没绑过返回 null */
export async function 演示码剩余(visitorId: string): Promise<{ code: string; 用掉: number; 还剩: number } | null> {
  const d = await control.demoCode.findUnique({ where: { boundVisitor: visitorId } });
  if (!d) return null;
  return { code: d.code, 用掉: Math.min(d.calls, 演示对话上限), 还剩: Math.max(0, 演示对话上限 - d.calls) };
}

/** 演示区扣一次。先自增再判断，理由同 ai-allowance 里的试用额度 */
export async function 演示码扣一次(visitorId: string): Promise<{ ok: true; 还剩: number } | { ok: false; error: string }> {
  const r = await control.demoCode.updateMany({ where: { boundVisitor: visitorId }, data: { calls: { increment: 1 } } });
  if (r.count !== 1) return { ok: false, error: "请先用演示码进入演示区" };
  const d = await control.demoCode.findUniqueOrThrow({ where: { boundVisitor: visitorId }, select: { calls: true } });
  if (d.calls > 演示对话上限) {
    return { ok: false, error: `这个演示码的 ${演示对话上限} 次 AI 对话已经用完。其余功能照常可用；想要自己的工作区，到官网申请试用。` };
  }
  return { ok: true, 还剩: 演示对话上限 - d.calls };
}

/* ---------- 万能试用码：一个，可换 ---------- */

export async function 取万能码(): Promise<string | null> {
  const m = await control.trialMasterCode.findUnique({ where: { id: "trial" } });
  return m?.code ?? null;
}

/** 换一个新的万能码，旧的立刻作废。外传了就按这个 */
export async function 换万能码(): Promise<string> {
  const code = 生成一个();
  await control.trialMasterCode.upsert({
    where: { id: "trial" },
    create: { id: "trial", code },
    update: { code, rotatedAt: new Date() },
  });
  return code;
}

export async function 核验万能码(raw: string): Promise<boolean> {
  const code = 归一化(raw);
  if (!code) return false;
  const m = await 取万能码();
  return Boolean(m) && m === code;
}
