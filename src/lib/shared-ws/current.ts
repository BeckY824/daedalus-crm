/**
 * 「现在这个请求是不是跑在网页那个共享工作区里」。
 *
 * 那个工作区是多个团队共用一套账号密码进来的：A 团队录的东西 B 团队看得见。
 * 所以它要比自己部署的实例更保守——手机号这类字段不能原样显示，
 * 数据虽然多半是编的，但一串 11 位数字在截图和录屏里与真号无从分辨。
 *
 * 判断本身和 (app)/layout.tsx 里那段同源，都落到 `是共享工作区`。
 * 单实例自部署（非多租户）永远返回 false，不影响任何人看自己的号码。
 */
import { multiTenant } from "@/lib/tenant/context";
import { resolveCurrentTenant } from "@/lib/tenant/resolve";
import { control } from "@/lib/tenant/control";
import { 是共享工作区 } from "./config";
import { maskPhone } from "@/lib/utils";

export async function 当前是共享区(): Promise<boolean> {
  if (!multiTenant()) return false;
  const t = await resolveCurrentTenant();
  if (!t) return false;
  const ws = await control.workspace.findUnique({ where: { id: t.workspaceId } });
  return 是共享工作区(ws?.slug);
}

/**
 * 给服务端页面用的号码脱敏器：共享区打码，自部署实例原样返回。
 *
 * 返回的是函数而不是布尔值，调用点就不必各写一遍三元表达式，
 * 也不会出现「这一页记得打码、那一页忘了」的漂移——客户列表、联系人、
 * 记录页三处共用同一个出口。
 */
export async function 号码脱敏器(): Promise<<T extends string | null>(p: T) => T> {
  const 共享 = await 当前是共享区();
  return <T extends string | null>(p: T): T => (共享 && p ? (maskPhone(p) as T) : p);
}
