/**
 * 「自动判断」这个开关。
 *
 * 它存在的理由写在隐私政策第三节：这一类调用**不用用户点**就会发生，
 * 而发生的地方（导入表格）在用户看来根本不是 AI 功能。
 * 一个不用点就跑的东西，必须给得出一个关掉它的地方，否则那节政策就没法诚实地写。
 *
 * 默认开。关掉之后导入回落到 `猜列()` 那张同义词表——那本来就是默认路径，
 * 所以「关掉」不是残废，是回到 2026-09-20 之前的样子。
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
  return s?.开 !== false;
}

export async function 设自动判断(开: boolean): Promise<void> {
  await setSetting(KEY, { 开 });
}
