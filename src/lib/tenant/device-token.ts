import { createHash, randomBytes } from "node:crypto";
import { control } from "./control";

/**
 * 桌面端的长期令牌。
 *
 * 桌面端的数据在用户自己机器上，它连云端只为两件事：认领账号、调模型网关。
 * 所以它拿的不是网页那种会话 cookie，而是一枚长期令牌，直接当模型接口的 API Key 用——
 * 桌面端的 AI 配置于是就是标准的「接口地址 + Key」，和用户自己填 DeepSeek 的 Key
 * 走同一条代码路径，llm.ts 一行都不用改。
 *
 * **只存 sha256，不存明文。** 令牌等价于「这个账号的免费额度」，库被拖走不该等于
 * 额度被拿走。代价是我们自己也找不回明文，所以签发时那一次必须交给用户存好。
 * 不加盐：令牌本身就是 32 字节随机数，没有字典可查，加盐只会让查询没法走索引。
 */

const 前缀 = "dk_";

export function 生成明文(): string {
  return 前缀 + randomBytes(32).toString("base64url");
}

export function 指纹(token: string): string {
  return createHash("sha256").update(token.trim()).digest("hex");
}

export function 像令牌吗(v: string): boolean {
  return v.trim().startsWith(前缀);
}

/** 签发。明文只在这里返回这一次 */
export async function 签发(accountId: string, name: string): Promise<{ id: string; token: string }> {
  const token = 生成明文();
  const row = await control.deviceToken.create({
    data: { accountId, tokenHash: 指纹(token), name: name.trim().slice(0, 40) || "未命名设备" },
  });
  return { id: row.id, token };
}

/** 上次使用时间的写入节流：每次调用都写一次库，等于给每个模型请求加一次写 */
const 记录间隔毫秒 = 5 * 60 * 1000;

/**
 * 认令牌。认不出、被吊销都返回 null——**不区分**，区分开就成了令牌探测接口。
 */
export async function 认领(raw: string | null | undefined): Promise<{ id: string; accountId: string } | null> {
  const token = raw?.trim();
  if (!token || !像令牌吗(token)) return null;
  const row = await control.deviceToken.findUnique({ where: { tokenHash: 指纹(token) } });
  if (!row || row.revokedAt) return null;

  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 记录间隔毫秒) {
    // 记时间失败不该让调用失败：它只是给人看「这台机器还在用吗」
    await control.deviceToken.update({ where: { id: row.id }, data: { lastUsedAt: new Date() } }).catch(() => {});
  }
  return { id: row.id, accountId: row.accountId };
}

/** 从 Authorization: Bearer xxx 里取出令牌 */
export function 取Bearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : null;
}

export async function 列出(accountId: string) {
  return control.deviceToken.findMany({
    where: { accountId, revokedAt: null },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, createdAt: true, lastUsedAt: true },
  });
}

/** 吊销。只能吊销自己的——不带 accountId 的话，猜到 id 就能把别人的机器踢下线 */
export async function 吊销(id: string, accountId: string): Promise<boolean> {
  const r = await control.deviceToken.updateMany({
    where: { id, accountId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return r.count === 1;
}
