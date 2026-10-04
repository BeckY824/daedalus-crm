/**
 * 「导入时让 AI 认列」这个开关（存的键还叫 assist，函数名还叫自动判断——老名字，别跟着改存储）。
 *
 * 原来它管的是一件**不用用户点**就会发生的事：导入读完表就自动把认不出的列的表头和前 3 行发给判断模型。
 * 2026-10-04（L-076）改成人在导入第 1 步点「让 AI 认一下」才发，这个开关现在只管那颗按钮在不在。
 *
 * **默认关**（原来默认开）。管理员在「设置 → AI 接入」里打开。共享试用区里谁都改不了它
 * （settings/actions.ts 设自动判断开关，H-037），所以那儿一直是关的——别的团队替不了你打开。
 */
import { getSetting, setSetting } from "../settings";
import { 判断可用 } from "./client";

const KEY = "assist";

type 存的 = { 开?: boolean };

/**
 * 连不上判断模型的部署（自部署的开源版多半如此）一律当关着，界面上也不用摆那个开关。
 *
 * **这里必须问 `判断可用()`，不能直接看 JEV_API_KEY。** 桌面端本机没有那个环境变量
 * ——它靠设备令牌走我们的网关。写成看环境变量的话，桌面端会在调用之前就被自己拦掉，
 * 而且一声不吭：日志干净、界面只是少猜几列，看不出是被谁挡的。这个坑踩过一次了。
 */
export async function 自动判断开着(): Promise<boolean> {
  if (!判断可用()) return false;
  const s = await getSetting<存的>(KEY);
  // 默认关：没存过的（包括 10-04 之前默认开着、从没碰过开关的）一律当关着（L-076）
  return s?.开 === true;
}

export async function 设自动判断(开: boolean): Promise<void> {
  await setSetting(KEY, { 开 });
}
