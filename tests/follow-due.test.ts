/**
 * 「要跟的数」只有一个：Dock 上的、左栏「跟进」上的、手机顶栏铃铛上的、跟进记录页「计划」按钮上的。
 * 2026-09-29 用户：Dock 上挂着 1，打开应用不知道去哪儿看、去哪儿处理——那时应用里没有任何地方写着这个 1，
 * 手机顶栏的铃铛倒有个数，数的却是「全部没做完的待办」，又是另一个意思。
 * 这里钉住：三处都走 lib/reminders-db.ts 的 取提醒项 + lib/reminders.ts 的 算提醒，谁换了口径就红。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const 读 = (rel: string) => fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");

describe("要跟的数：一个口径、处处一样", () => {
  it("Dock 的接口和页面布局取的是同一份（取提醒项 → 算提醒），不再各数各的", () => {
    const 接口 = 读("src/app/api/desktop/reminders/route.ts");
    const 布局 = 读("src/app/(app)/layout.tsx");
    for (const 源 of [接口, 布局]) {
      expect(源).toContain("取提醒项(");
      expect(源).toContain("算提醒(");
    }
    // 原来铃铛数的是「全部没做完的待办」
    expect(布局).not.toMatch(/task\.count\(/);
  });

  it("左栏「跟进」、手机铃铛、记录页「计划」按钮都挂它", () => {
    const 壳 = 读("src/components/AppShell.tsx");
    expect(壳).toContain('n.key === "/follow-ups" && 要跟数 > 0');
    expect(壳).toMatch(/<Badge count=\{要跟数\}/);
    expect(读("src/app/(app)/follow-ups/FollowUpsView.tsx")).toContain("useFollowDue()");
  });

  it("这个数一变就叫桌面端的壳马上再问，Dock 不用等下一分钟", () => {
    // 2026-10-03 起 Dock 上的数还加上订单节点：两个数的和一变就问
    expect(读("src/components/AppShell.tsx")).toMatch(/上次要跟\.current !== 要跟数 \+ 订单数\) void window\.desktopReminders\?\.刷新\(\)/);
  });

  /*
    【下一版】回归核对 D-046：上面那条只在「要跟的数」变了才叫壳。记录页建一条明天上午的计划、或者今天稍后定了钟点的那种，
    要跟数不变 → 壳不知道，Dock 和到点提醒要等下一分钟那一问才跟上。跟进框、待办框、计划页已经各自叫了刷新；
    记录页的 PlanForm 保存、完成计划还没叫。最多晚一分钟、不丢提醒，排下一版；补上调用点后去掉 skip
  */
  it.skip("【下一版】D-046 记录页建计划 / 完成计划之后也马上叫壳再问", () => {
    expect(读("src/app/(app)/customers/[id]/PlanForm.tsx")).toContain("window.desktopReminders?.刷新()");
    const 记录页 = 读("src/app/(app)/customers/[id]/RecordView.tsx");
    const 段 = 记录页.slice(记录页.indexOf("async function 完成计划"), 记录页.indexOf("const fingerprint"));
    expect(段).toContain("window.desktopReminders?.刷新()");
  });
});
