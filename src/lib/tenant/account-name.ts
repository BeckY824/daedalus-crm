/**
 * 改自己的名字（云端账号名，2026-10-15 0.46.17 实测修）。
 *
 * 原来云端账号名注册时填了就再也改不了：桌面端设置里改的只是本机那一行，
 * 于是手机「我的」、电脑 / 手机授权框、运营台显示的一直是注册名。
 * 现在桌面端改名时一并调这里（按设备令牌认人，只改本人）。规则和桌面端「个人资料」一样：不能空、最多 20 个字。
 */
import { control } from "./control";

type 结果<T> = ({ ok: true } & T) | { ok: false; 状态: number; error: string };

export const 名字最长 = 20;

/** 去掉首尾空白、把中间连串空白（含换行、制表）并成一个空格；控制字符不收 */
export function 规整名字(raw: unknown): { ok: true; name: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "名字要是文字" };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(raw)) return { ok: false, error: "名字里有看不见的字符，重新输一下" };
  const name = raw.replace(/\s+/g, " ").trim();
  if (!name) return { ok: false, error: "名字不能为空" };
  if ([...name].length > 名字最长) return { ok: false, error: `名字最多 ${名字最长} 个字` };
  return { ok: true, name };
}

export async function 取账号名(accountId: string): Promise<结果<{ name: string }>> {
  const a = await control.account.findUnique({ where: { id: accountId }, select: { name: true, active: true } });
  if (!a || !a.active) return { ok: false, 状态: 401, error: "登录已失效，请重新登录" };
  return { ok: true, name: a.name };
}

export async function 改账号名(accountId: string, raw: unknown): Promise<结果<{ name: string }>> {
  const n = 规整名字(raw);
  if (!n.ok) return { ok: false, 状态: 400, error: n.error };
  const a = await control.account.findUnique({ where: { id: accountId }, select: { name: true, active: true } });
  if (!a || !a.active) return { ok: false, 状态: 401, error: "登录已失效，请重新登录" };
  if (a.name !== n.name) await control.account.update({ where: { id: accountId }, data: { name: n.name } });
  return { ok: true, name: n.name };
}
