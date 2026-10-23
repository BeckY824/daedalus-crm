/**
 * 手机端看团队的产品图片（2026-10-22 D-24）：只读。
 *
 * 行（Attachment）跟着范围同步已经在手机库里了，权限和电脑上一样由服务端按商机 / 订单把关；
 * 文件走 /api/sync/attach 的密文通道（lib/tenant/sync-attach.ts），点开才取，取到的用团队钥匙解开、核过 sha256 才显示。
 * 手机不传图、不删图，也不落盘（只在这次打开的页面里留着），换钥匙前的老图用钥匙环解。
 */
import * as 密 from "@/lib/sync/crypto-web";
import type { 手机团队 } from "./sync";

/** 取字节：同源 GET + 手机令牌。断网回 状态 0 */
export type 字节传输 = (路径: string) => Promise<{ 状态: number; 字节?: Uint8Array; json: Record<string, unknown> }>;

export type 取图结果 = { 状态: "有"; 字节: Uint8Array } | { 状态: "还在上传" } | { 状态: "没有"; 原因: string };

export async function 取图片(c: 手机团队, 取: 字节传输, 图: { id: string; sha256: string }): Promise<取图结果> {
  const q = new URLSearchParams({ teamId: c.teamId, id: 图.id, device: c.device });
  const r = await 取(`/api/sync/attach?${q}`);
  if (r.状态 === 0) return { 状态: "没有", 原因: "连不上网络，联网后再点开" };
  if (r.状态 === 404 && r.json.uploading) return { 状态: "还在上传" };
  if (r.状态 === 404) return { 状态: "没有", 原因: "云端还没有这张图：传图的电脑同步一次就有了" };
  if (r.状态 === 403) return { 状态: "没有", 原因: "这张图你看不到了（商机或订单可能已经转给别人）" };
  if (r.状态 !== 200 || !r.字节) return { 状态: "没有", 原因: String(r.json.error ?? `取不到这张图（${r.状态}）`) };
  let 明: Uint8Array;
  try {
    明 = await 密.拆附件(r.字节, { ...c.keys, [String(c.epoch)]: c.key }, { teamId: c.teamId, id: 图.id, sha256: 图.sha256 });
  } catch {
    return { 状态: "没有", 原因: "解不开这张图：先下拉同步一次，再点开" };
  }
  if ((await 密.字节sha256(明)) !== 图.sha256) return { 状态: "没有", 原因: "这张图和记录对不上，没显示" };
  return { 状态: "有", 字节: 明 };
}
