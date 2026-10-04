import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { 只留当前行, 删除确认标题, 露出这一列, 算可见列, 切换后存 } from "@/lib/list-select";

/**
 * 列表页多选和横滚的几条规矩（交互审查 2026-09-28 的 S4、S5）。
 * 逻辑在 lib/list-select.ts，DataList 只管调；这里钉住逻辑，末尾一条用源码钉住「DataList 真的调了」。
 */
describe("勾选只认眼前的行（S4）", () => {
  it("换筛选以后，不在当前行里的勾选清掉", () => {
    expect(只留当前行(["a", "b", "c"], ["b", "x", "y"])).toEqual(["b"]);
  });

  it("一个都不在了就清空——工具条随之消失，批量删除点不到看不见的人", () => {
    expect(只留当前行(["a", "b", "c"], ["x"])).toEqual([]);
  });

  it("行没变（router.refresh 换了数组但 id 一样）时原样返回同一个数组，不白渲染", () => {
    const 选中 = ["a", "b"];
    expect(只留当前行(选中, ["a", "b", "c"])).toBe(选中);
    const 空: string[] = [];
    expect(只留当前行(空, ["a"])).toBe(空);
  });
});

describe("批量删除的确认框写出是谁（S4）", () => {
  it("一位：直接写名字", () => {
    expect(删除确认标题(["何静"], 1, "客户")).toBe("确认删除客户 何静？");
  });

  it("三位以内：全列出来", () => {
    expect(删除确认标题(["何静", "孙婉"], 2, "客户")).toBe("确认删除 何静、孙婉 这 2 位客户？");
    expect(删除确认标题(["何静", "孙婉", "张一"], 3, "学员")).toBe("确认删除 何静、孙婉、张一 这 3 位学员？");
  });

  it("超过三位：列前三个，写「等 N 位」", () => {
    expect(删除确认标题(["何静", "孙婉", "张一", "李二", "王三"], 5, "客户")).toBe("确认删除 何静、孙婉、张一 等 5 位客户？");
  });

  it("叫法跟着业务配置走，不写死「客户」", () => {
    expect(删除确认标题(["Tom"], 1, "买家")).toBe("确认删除买家 Tom？");
  });

  it("名字比人数少（有的行没名字）：按人数说，名字只列拿得到的", () => {
    expect(删除确认标题(["何静", ""], 2, "客户")).toBe("确认删除 何静 等 2 位客户？");
    expect(删除确认标题([], 3, "客户")).toBe("确认删除选中的 3 位客户？");
  });
});

describe("勾上一列后挪进视野，左右都让开固定列（S5）", () => {
  // 框 800 宽，左边固定 勾选框 32 + 名字 160 = 192，右边固定操作列 78
  const 基 = { 框宽: 800, 左固定: 192, 右固定: 78 };

  it("新列在右边外面：挪到右沿刚好露出，让开操作列", () => {
    // 列 1000–1120，看得见的右沿 = 0 + 800 - 78 = 722
    expect(露出这一列({ ...基, 滚到: 0, 列左: 1000, 列宽: 120 })).toBe(1120 - 800 + 78);
  });

  it("已经看得见：不动", () => {
    expect(露出这一列({ ...基, 滚到: 0, 列左: 300, 列宽: 120 })).toBeNull();
  });

  it("列的开头压在固定的名字列底下：往回挪，贴着名字列露出来", () => {
    // 已经滚到 400，看得见的左沿 = 400 + 192 = 592；列从 450 开始，被名字列盖住
    expect(露出这一列({ ...基, 滚到: 400, 列左: 450, 列宽: 120 })).toBe(450 - 192);
  });

  it("没有固定列时和原来一样只按框宽算", () => {
    expect(露出这一列({ 滚到: 0, 框宽: 800, 左固定: 0, 右固定: 0, 列左: 900, 列宽: 100 })).toBe(200);
  });
});

describe("DataList 真的用上了这些规矩", () => {
  it("行一变就清勾选、勾选框固定、第一列固定在左边、横滚走 露出这一列", async () => {
    const src = await readFile("src/components/DataList.tsx", "utf8");
    expect(src).toMatch(/只留当前行\(/);
    expect(src).toMatch(/fixed: true/);
    expect(src).toMatch(/fixed: "left"/);
    expect(src).toMatch(/露出这一列\(/);
  });
});

/**
 * 列设置（2026-10-04 上线前第 2 期 2b，e2e/column-hide 抓到）：默认显示的列勾掉之后，原来读的时候被当成
 * 「存完之后新加的列」补回来，怎么也藏不住。藏起来的默认列记成「-键」。
 */
describe("列设置：存的 → 显示哪几列", () => {
  const 列 = [
    { 键: "name", 默认显示: true },
    { 键: "followStatus", 默认显示: true },
    { 键: "grade", 默认显示: false },
  ];

  it("没存过：按默认", () => {
    expect(算可见列(列, null)).toEqual(["name", "followStatus"]);
  });

  it("勾掉一列默认显示的：存下来再读，它不再出来", () => {
    const 存 = 切换后存(算可见列(列, null), null, "followStatus", false);
    expect(算可见列(列, 存)).toEqual(["name"]);
  });

  it("勾掉再勾回来：又显示；勾上默认藏着的也显示", () => {
    let 存 = 切换后存(["name", "followStatus"], null, "followStatus", false);
    存 = 切换后存(算可见列(列, 存), 存, "followStatus", true);
    expect(算可见列(列, 存)).toEqual(["name", "followStatus"]);
    存 = 切换后存(算可见列(列, 存), 存, "grade", true);
    expect(算可见列(列, 存)).toEqual(["name", "followStatus", "grade"]);
  });

  it("存完之后新加的、默认显示的列照样补上（老格式也一样）；藏过的不补", () => {
    const 新列 = [...列, { 键: "phone", 默认显示: true }];
    expect(算可见列(新列, ["name", "followStatus"])).toEqual(["name", "followStatus", "phone"]);
    expect(算可见列(新列, ["name", "-followStatus"])).toEqual(["name", "phone"]);
  });
});
