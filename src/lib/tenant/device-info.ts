import { control } from "./control";

/**
 * 每台桌面端装的是什么：系统、芯片、版本号。给运营台分 Mac / Windows、看谁停在老版本。
 *
 * 桌面端打云端的每个请求都带三个头（desktop/cloud.js 和 lib/desktop/cloud.ts 的 请求()）：
 *   X-Client-Platform  darwin | win32 | linux
 *   X-Client-Arch      arm64 | x64 | ia32
 *   X-Client-Version   0.46.7 这样的三段版本号
 * 登录时记一次（api/account/token），之后每次启动验令牌时更新（api/gateway/v1/credits）。
 *
 * **只收认得的值**：头是客户端自己说的，乱填的一律当没带——
 * 运营台上多出一种叫「<script>」的系统，比显示「未知」糟得多。
 * **永不抛**：记不上只影响运营台上那一格，不该让人登录失败、或者看不到余额。
 */

export type 客户端 = { platform: "darwin" | "win32" | "linux"; arch: string | null; version: string | null };

const 认得的系统 = new Set(["darwin", "win32", "linux"]);
const 认得的芯片 = new Set(["arm64", "x64", "ia32"]);

/** 从请求头里读。系统认不出就整个当没带（老版本、第三方客户端） */
export function 读客户端(req: Request): 客户端 | null {
  const p = (req.headers.get("x-client-platform") ?? "").trim().toLowerCase();
  if (!认得的系统.has(p)) return null;
  const a = (req.headers.get("x-client-arch") ?? "").trim().toLowerCase();
  const v = (req.headers.get("x-client-version") ?? "").trim().replace(/^v/, "");
  return {
    platform: p as 客户端["platform"],
    arch: 认得的芯片.has(a) ? a : null,
    version: /^\d{1,3}\.\d{1,3}\.\d{1,4}$/.test(v) ? v : null,
  };
}

/** 记下来。和上次一样就不写：每次启动都会来一趟，没变化的写入是白写 */
export async function 记设备(deviceTokenId: string, c: 客户端 | null): Promise<void> {
  if (!c) return;
  try {
    const 旧 = await control.deviceInfo.findUnique({ where: { deviceTokenId } });
    if (旧 && 旧.platform === c.platform && 旧.arch === c.arch && 旧.version === c.version) return;
    const data = { platform: c.platform, arch: c.arch, version: c.version, updatedAt: new Date() };
    await control.deviceInfo.upsert({ where: { deviceTokenId }, create: { deviceTokenId, ...data }, update: data });
  } catch (e) {
    console.warn("[device-info] 没记上：", e instanceof Error ? e.message : e);
  }
}

// 给人看的那几样（系统名、按系统数、说法）不碰库，客户端组件也要用，放在 device-os.ts
export { 系统名, 数设备, 分布说法, type 设备分布 } from "../device-os";
