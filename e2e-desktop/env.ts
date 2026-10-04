/**
 * 桌面端本地模式 e2e 的几样共享常量：配置文件、准备脚本、用例三处都要用，
 * 写在一处免得端口 / 令牌 / 路径改了一处忘了另一处（那样不报错，只是用例连到别处去了）。
 */
import path from "node:path";

export const ROOT = path.resolve(__dirname, "..");

/** 和默认套（3100）、托管套（3400）错开；并行跑几份工作树时用 E2E_PORT 改 */
export const PORT = Number(process.env.E2E_PORT) || 3300;
/** 云端桩紧挨着本地服务，跟着 E2E_PORT 一起挪，不会和另一份工作树的桩撞端口 */
export const CLOUD_PORT = PORT + 1;
export const CLOUD_URL = `http://127.0.0.1:${CLOUD_PORT}`;
export const BASE_URL = `http://localhost:${PORT}`;

/** 独立的库和数据目录：不碰默认 e2e 库、开发库，更不碰用户真实的桌面端数据目录 */
export const DB = path.resolve(ROOT, "prisma/e2e-desktop.db");
export const DATA_DIR = path.resolve(ROOT, "prisma/e2e-desktop-data");

/** 真壳里这是每次启动现生成的一次性令牌；e2e 固定一个，用例才拿得到 */
export const DESKTOP_TOKEN = "e2e-desktop-token-0123456789abcdef";

/** 登录过的那个云端账号（写进 .cloud.json，管理员的名字邮箱按它对齐，同 desktop/server-entry.js） */
export const 云端账号 = { id: "acc_e2e", name: "林小雨", contact: "xiaoyu@example.com", token: "dk_e2e_device_token" };

/** 自动登录那一跳 */
export const 进门地址 = (next?: string) =>
  `/api/desktop/session?t=${encodeURIComponent(DESKTOP_TOKEN)}${next ? `&next=${encodeURIComponent(next)}` : ""}`;
