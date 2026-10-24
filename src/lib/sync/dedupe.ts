/**
 * 团队版跨成员查重（2026-10-19 用户拍板）：范围同步下业务员库里只有本人 + 公海，同事名下的号码本机查不到，
 * 同一位客户被两个人各录一份。服务端替全队记一份「号码 → 是哪位客户」的索引，录入时问一下。
 *
 * 服务器看不到内容（团队钥匙只在成员手里），索引里也不能有明文：
 *   - 号码 / 邮箱 / 微信号先规整（和本机查重同一把尺子：号键、去空格小写），再用团队钥匙做 HMAC——
 *     中转只见得到哈希，手机号空间小也没法反推（没有钥匙算不出同一个哈希）
 *   - 客户名用团队钥匙封起来存着，查到时只回给问的人，由他本机解开：只露同事名 + 客户名，客户的其它资料一概不给
 *   - 换钥匙（移除成员）后旧哈希对不上新钥匙：每条记着钥匙编号，各台按新钥匙重报一遍
 *
 * 这里只放电脑（node）和手机（浏览器）共用的纯规则；算 HMAC 在 crypto.ts / crypto-web.ts，服务端在 tenant/sync-scoped.ts（收查重索引 / 查查重）。
 */
import { 号键 } from "@/lib/phone";

/** alibaba = 阿里国际站买家 ID（2026-10-21）：服务端只见哈希、不认种类，加一种不用动服务端；一位最多 4 样，在服务端「一问 6 个」以内 */
export type 查重种类 = "phone" | "email" | "wechat" | "alibaba";
export const 查重种类们: readonly 查重种类[] = ["phone", "email", "wechat", "alibaba"];

/** 和本机查重同一个规整：电话按号键（lib/phone），邮箱 / 微信号 / 阿里 ID 去首尾空格、不分大小写（lib/email-dedupe 邮箱键） */
export function 查重键(种: 查重种类, 值: string | null | undefined): string {
  const s = String(值 ?? "").trim();
  if (!s) return "";
  return 种 === "phone" ? 号键(s) : s.toLowerCase();
}

/** 一位客户在索引里的几样（空的不算）。去重：WhatsApp 当电话存的、邮箱和微信写成一样的，只留一份 */
export function 客户查重值(c: { phone?: string | null; email?: string | null; wechat?: string | null; alibaba?: string | null }): { 种: 查重种类; 键: string }[] {
  const 出: { 种: 查重种类; 键: string }[] = [];
  for (const 种 of 查重种类们) {
    const 键 = 查重键(种, 种 === "phone" ? c.phone : c[种]);
    if (键 && !出.some((x) => x.种 === 种 && x.键 === 键)) 出.push({ 种, 键 });
  }
  return 出;
}

/** 进 HMAC 的原文：带上团队和种类，不同团队、电话和微信号碰巧一样时哈希也不一样；和事件编号（标签|规范串）分开 */
export const 查重原文 = (teamId: string, 种: 查重种类, 键: string) => `dedupe-v1|${teamId}|${种}|${键}`;

/** 客户名封起来时绑的「设备」：不是哪台设备，只是让这份密文只能当查重标签解 */
export const 查重标签绑定 = (teamId: string) => ({ teamId, device: "dedupe-label" });

/** 上报给服务端的一条：k 是客户 id；hashes 是这位客户的几样哈希；label 是封好的客户名 */
export type 查重条目 = { k: string; epoch: number; hashes: string[]; label: string };
/** 服务端回的一条：问的人看不到的同事客户（看得到的本机自己就查到了） */
/** dept：负责人所在的一级部门名（团队版 1b，团队有两个以上一级部门时才有），桌面端在查重结果里标「内贸 / 外贸」 */
export type 查重命中 = { k: string; owner: string; label: string; dept?: string };

/** 一位客户这一轮要报的内容有没有变：钥匙编号 + 哈希 + 封之前的名字。存的是这个，不是密文（密文每次封都不一样） */
export const 查重指纹 = (epoch: number, hashes: string[], 名: string) => `${epoch}|${[...hashes].sort().join(",")}|${名}`;

/** 一次报多少条、一次问几样 */
export const 查重单次上限 = 300;
export const 查重一问上限 = 6;
export const 查重哈希格式 = /^[0-9a-f]{64}$/;

/** 撞到同事名下时那句话（电脑表单、保存、手机新建同一句）：只露同事是谁 + 客户叫什么，客户的其它资料一概不给（10-19 拍板） */
export const 同事撞号说法 = (依据: string, 同事: string, 客户名: string, 叫法 = "客户") =>
  `${依据} 已是同事 ${同事} 名下的${叫法}${客户名 ? `（${客户名}）` : ""}，请勿重复录入；要接手请找 ${同事} 或老板`;
