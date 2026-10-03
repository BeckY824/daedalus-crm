/**
 * 第五轮（打包实机验 0.46.15）：退出那一下页面还在加载，app.log 被记一条假的「本地服务没能启动」。
 *
 * 实机复现（打出来的 .app，本机真实数据的副本，假云端「连得上但不回」）：
 *   启动 → 窗口可交互后约 6 秒内页面 document 还在 loading（服务端在等云端）→ ⌘Q
 *   → before-quit 停掉本地服务 → 正在流式返回的那一页断掉，did-fail-load 报 -355
 *   （ERR_INCOMPLETE_CHUNKED_ENCODING）→ 报告本地故障() 写进 app.log「本地服务没能启动（-355）」，
 *   还会去弹那个「本机的 CRM 服务没能起来」的错误框（进程正在退，多数时候一闪而过或弹不出来）。
 * 网正常时页面很快就加载完，撞上的概率小；网差（连得上但不回）时启动后十来秒内退出必中。
 * 坏处：日志里多一条假故障，排查「打不开」时会被它带偏；偶尔用户能看到一闪的错误框。
 *
 * 修法：before-quit 里立一个「正在退出」的标记，did-fail-load 看到它就直接 return。
 * 修好后把 it.skip 去掉。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const main = fs.readFileSync(path.resolve(__dirname, "../desktop/main.js"), "utf8");

/** 从 `app.on("before-quit"` / `"did-fail-load"` 起往后取一段（到下一个顶层 app.on / webContents.on 为止，够用） */
function 取一段(起点: string, 长度 = 2500): string {
  const i = main.indexOf(起点);
  expect(i, `main.js 里找不到 ${起点}`).toBeGreaterThan(-1);
  return main.slice(i, i + 长度);
}

describe("退出时页面加载被打断，不算本地服务故障", () => {
  it("did-fail-load 和 before-quit 都还在（下面那条的前提）", () => {
    expect(取一段('webContents.on("did-fail-load"')).toContain("报告本地故障(");
    expect(main).toContain('app.on("before-quit"');
  });

  it("before-quit 立的「正在退出」标记，did-fail-load 在报故障前先看它", () => {
    const 退出段 = 取一段('app.on("before-quit"', 4000);
    // before-quit 里置 true 的那些变量（比如 正在退出 = true）
    const 标记 = [...退出段.matchAll(/([\p{L}_$][\p{L}\p{N}_$]*)\s*=\s*true\b/gu)].map((m) => m[1]);
    expect(标记.length, "before-quit 里没有立任何「正在退出」的标记").toBeGreaterThan(0);
    const 失败段 = 取一段('webContents.on("did-fail-load"');
    const 报故障前 = 失败段.slice(0, 失败段.indexOf("报告本地故障("));
    expect(
      标记.some((x) => 报故障前.includes(x)),
      `did-fail-load 在 报告本地故障() 之前没看 ${标记.join(" / ")}：退出时被打断的加载会被当成本地服务没起来`,
    ).toBe(true);
  });
});
