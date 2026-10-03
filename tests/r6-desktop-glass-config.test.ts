/**
 * 第六轮（打包实机验 0.46.15，合并毛玻璃界面之后）：设置 → 外观 →「窗口：实底」拨了没用。
 *
 * 实机复现（打出来的 .app，本机真实数据的副本）：
 *   设置 → 外观 → 点「实底」→ config.json 里确实写进了 "glass": false，
 *   可窗口照旧透着壁纸，<html> 还挂着 glass 类，单选框一来一回又跳回「毛玻璃」；
 *   随便点去别的页（记 lastRoute 那次写配置），config.json 里的 glass 就没了。退出再开当然也还是毛玻璃。
 *
 * 原因：读配置() 只把 mode / serverUrl / lastUpdateCheck / lastRoute 四个字段读回来，**没读 glass**，
 *   所以 玻璃开着() 里的 读配置().glass 永远是 undefined（= 开），
 *   而所有 写配置({ ...读配置(), xxx }) 都会把 glass 顺手抹掉。
 *
 * 修法：读配置() 的返回里加一行 `glass: c.glass,`。修好后把 it.skip 去掉。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const main = fs.readFileSync(path.resolve(__dirname, "../desktop/main.js"), "utf8");

/** 把 main.js 里的 function 读配置() {...} 原样抠出来，配一个假的 fs 跑一遍 */
function 造读配置(文件内容: Record<string, unknown>): () => Record<string, unknown> {
  const i = main.indexOf("function 读配置()");
  expect(i, "main.js 里找不到 function 读配置()").toBeGreaterThan(-1);
  // 函数体到第一个顶格的 "\n}" 为止
  const j = main.indexOf("\n}", i);
  const 源码 = main.slice(i, j + 2);
  const 假fs = {
    existsSync: () => true,
    readFileSync: () => JSON.stringify(文件内容),
    mkdirSync: () => {},
    copyFileSync: () => {},
  };
  const 沙箱 = { fs: 假fs, path, CONFIG_FILE: "/x/config.json", 旧数据目录: "/x", 数据根: "/x", 默认服务器: "https://app.example.com", out: null as unknown };
  vm.runInNewContext(`${源码}\nout = 读配置;`, 沙箱);
  return 沙箱.out as () => Record<string, unknown>;
}

describe("毛玻璃开关存得住", () => {
  it("读配置() 本身还能跑（下面那条的前提）", () => {
    const 读 = 造读配置({ mode: "local", lastRoute: "/customers" });
    expect(读()).toMatchObject({ mode: "local", lastRoute: "/customers" });
  });

  it("config.json 里 glass:false，读配置() 要读回来——否则「实底」永远不生效，下一次写配置还把它抹掉", () => {
    const 读 = 造读配置({ mode: "local", glass: false });
    expect(读().glass, "读配置() 没把 glass 读回来：玻璃开着() 恒为 true，写配置({...读配置()}) 会把 glass 抹掉").toBe(false);
  });
});
