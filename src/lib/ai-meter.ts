/**
 * 「这个人点 AI 按钮要不要花次数、还剩几次」——界面上那个「1 次」角标和
 * 输入框下那行「免费次数还剩 N 次」都从这里取（components/AiCost.tsx）。
 *
 * 已拍板的规矩（2026-09-18「AI 不许自动跑」那条）：**按钮旁边写明它要花掉几次**。
 * 但只对真会花的人写——填了自己 Key 的、付费的、自部署的，一次都不扣，
 * 对他们写「1 次」就是一句在他那儿不成立的话。
 *
 * 谁计次，和真正扣次数的地方一一对应：
 *   托管版（MULTI_TENANT）   lib/tenant/ai-allowance.ts 的 带额度()——stream 和各个 AI 动作都套着它：付费工作区不扣（查额度().受限），
 *                            工作区在设置里填了自己 Key 的也不扣（自带Key()）
 *   桌面端登录了云端账号     云端网关按账号扣（lib/tenant/credits.ts 的 account 那一路）
 *   桌面端填了自己的 Key      请求直接发给他选的那家，不经过我们——不计
 *   自部署（.env 里配的 Key） 一次都不扣——不计
 *
 * 余额两种取法：托管版查控制面库（本地、快）；桌面端要去云端问（联网），
 * 所以布局里那一次不问（问余额: false），由浏览器在页面出来之后再问 /api/ai/meter。
 */
import { 模型来源, describeLlmConfig } from "./llm-config";
import { multiTenant } from "./tenant/context";

export type AI计次 = { 计次: boolean; 还剩: number | null; 上限: number | null };

export const 不计次: AI计次 = { 计次: false, 还剩: null, 上限: null };

export async function 读AI计次({ 问余额 }: { 问余额: boolean }): Promise<AI计次> {
  if (multiTenant()) {
    const { resolveCurrentTenant } = await import("./tenant/resolve");
    const t = await resolveCurrentTenant();
    if (!t) return 不计次;
    const { 查额度, 自带Key } = await import("./tenant/ai-allowance");
    const { 当前是测试账号 } = await import("./tenant/test-accounts");
    if (await 自带Key() || await 当前是测试账号(t.workspaceId)) return 不计次;
    const q = await 查额度(t.workspaceId);
    return q.受限 ? { 计次: true, 还剩: q.还剩, 上限: q.上限 } : 不计次;
  }
  const 来源 = await 模型来源();
  if (来源 !== "cloud") return 不计次;
  if (!问余额) return { 计次: true, 还剩: null, 上限: null };
  const d = await describeLlmConfig();
  // 测试账号（云端说 不限）：一次都不扣，「1 次」角标和「还剩 N 次」都不该挂
  if (d.credits?.不限) return 不计次;
  // 问不到（断网、云端没开网关）：照样计次，只是不报数——角标照挂，那行字换成不带数的说法
  return { 计次: true, 还剩: d.credits?.还剩 ?? null, 上限: d.credits?.上限 ?? null };
}
