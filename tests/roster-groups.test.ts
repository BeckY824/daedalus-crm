import { describe, it, expect } from "vitest";
import { 名单分组, 未填写组 } from "@/lib/roster-groups";
import { FOLLOW_STATUSES } from "@/lib/constants";

const 人 = (id: string, followStatus: string | null) => ({ id, followStatus: followStatus as string });

describe("名单按跟进状态分组：一个人都不能从分组视图里消失（2026-10-04 L-072）", () => {
  it("预设状态按预设顺序排，没人的组不出", () => {
    const g = 名单分组([人("a", "跟进中"), 人("b", "待跟进"), 人("c", "跟进中")]);
    expect(g.map((x) => [x.s, x.rows.map((r) => r.id)])).toEqual([["待跟进", ["b"]], ["跟进中", ["a", "c"]]]);
  });
  it("预设外的状态（老库 / 导入来的）→ 单独成组，接在预设后面，组名就是它自己", () => {
    const g = 名单分组([人("a", "意向强"), 人("b", FOLLOW_STATUSES[0]), 人("c", "意向强"), 人("d", "老客户")]);
    expect(g.map((x) => x.s)).toEqual([FOLLOW_STATUSES[0], "意向强", "老客户"]);
    expect(g.find((x) => x.s === "意向强")!.rows.map((r) => r.id)).toEqual(["a", "c"]);
  });
  it("空串 / 只有空格 / null 的状态 → 归到「未填写」，不成一个组头空白的组", () => {
    const g = 名单分组([人("a", ""), 人("b", "  "), 人("c", null), 人("d", "待跟进")]);
    expect(g.map((x) => x.s)).toEqual(["待跟进", 未填写组]);
    expect(未填写组).toBe("未填写");
    expect(g.find((x) => x.s === 未填写组)!.rows.map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(g.every((x) => x.s.trim() !== "")).toBe(true);
  });
  it("前后带空格的预设状态 → 并进同名的预设组，不出两个看着一样的组", () => {
    const g = 名单分组([人("a", " 跟进中 "), 人("b", "跟进中")]);
    expect(g).toHaveLength(1);
    expect(g[0].rows.map((r) => r.id)).toEqual(["a", "b"]);
  });
  it("分完组的人数加起来 = 进来的人数", () => {
    const 输入 = [人("a", ""), 人("b", "意向强"), 人("c", "待跟进"), 人("d", null), 人("e", "已签约")];
    expect(名单分组(输入).reduce((n, g) => n + g.rows.length, 0)).toBe(输入.length);
  });
});
