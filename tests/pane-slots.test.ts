/**
 * `@pane` 槽位页必须和 `(app)` 下的真实路由一一对应。
 *
 * Next 并行路由：客户端软导航时，**匹配不到的槽位会保留上一页的内容**，
 * `default.tsx` 只在硬加载（首次进入 / 刷新）时兜底。所以一条路由少了槽位页，
 * 症状不是「中栏没了」而是「中栏还留着上一页的」——从学员点到线索，
 * 左边那列学员赖着不走。很隐蔽，而且只在软导航时出现，手点一下未必发现。
 *
 * 所以：**新加一个页面，就要在 @pane 下加一个同名槽位页**；
 * 没有中栏的页面也要加，内容是 `无中栏`（返回 null）。这条用例就是那个提醒。
 *
 * （为什么不用一个 [...slug] 接住全部：那会把 `/[...slug]` 注册成真实路由，
 * 于是 `/demo`、打错的地址全都不再 404。见 @pane/panes.tsx 顶部。）
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const APP = path.resolve(__dirname, "../src/app/(app)");

/** 递归找出某个目录下所有 page.tsx 的路由路径 */
function 路由集(根: string, 跳过槽位: boolean): string[] {
  const 出: string[] = [];
  (function 走(dir: string, 前缀: string) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (跳过槽位 && e.name.startsWith("@")) continue;
        走(path.join(dir, e.name), `${前缀}/${e.name}`);
      } else if (e.name === "page.tsx") {
        出.push(前缀 || "/");
      }
    }
  })(根, "");
  return 出.sort();
}

describe("中栏槽位", () => {
  it("每条 (app) 路由都有一个同名的 @pane 槽位页，不多不少", () => {
    const 路由 = 路由集(APP, true);
    const 槽位 = 路由集(path.join(APP, "@pane"), false);
    expect(路由.length).toBeGreaterThan(5); // 防止两边同时扫空而假绿
    expect(槽位, "少了槽位页的路由，软导航时中栏会留着上一页的；多出来的是废文件").toEqual(路由);
  });

  it("有 default.tsx 兜底——并行槽位没有它，任何没建槽位页的路由都会 404", () => {
    expect(fs.existsSync(path.join(APP, "@pane/default.tsx"))).toBe(true);
  });
});
