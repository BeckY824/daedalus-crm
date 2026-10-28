/**
 * 外贸订单的样品、验货、海运、节点负责人（0.46.30 D-44～D-47）的纯规则：lib/order-track.ts
 *   - 返工：最近一轮验货不过才算，补一轮过就解了
 *   - 样品状态：不适用 / 未寄 / 已寄 / 已过 / 要改 / 重打
 *   - 到港灯：已到绿；过了预计到港还没到红；3 天内黄；更远或没填无
 *   - 尾款要催：到港红 / 黄且未收 > 0
 *   - 我该做的：我负责、没完成、不是不适用
 */
import { describe, it, expect } from "vitest";
import { 返工, 样品状态, 到港灯, 尾款要催, 我该做的, 下一轮次, 最近一轮 } from "@/lib/order-track";

const 现在 = new Date(2026, 9, 28, 10, 0); // 10-28 上午
const 天后 = (n: number, 时 = 12) => new Date(2026, 9, 28 + n, 时, 0);

describe("返工", () => {
  it("没有验货不算返工", () => {
    expect(返工([])).toBe(false);
    expect(返工([{ kind: "样品", round: 1, result: "要改" }])).toBe(false);
  });
  it("最近一轮不过 = 返工，后面补一轮过就解了", () => {
    expect(返工([{ kind: "验货", round: 1, result: "不过" }])).toBe(true);
    expect(返工([{ kind: "验货", round: 2, result: "过" }, { kind: "验货", round: 1, result: "不过" }])).toBe(false);
    expect(返工([{ kind: "验货", round: 1, result: "过" }, { kind: "验货", round: 2, result: "不过" }])).toBe(true);
  });
  it("最近一轮还没出结果，不算返工", () => {
    expect(返工([{ kind: "验货", round: 1, result: "不过" }, { kind: "验货", round: 2, result: null }])).toBe(false);
  });
});

describe("轮次", () => {
  it("下一轮次 = 同类最大轮次 + 1，各类各数各的", () => {
    const 轮们 = [{ kind: "样品", round: 1 }, { kind: "样品", round: 3 }, { kind: "验货", round: 1 }];
    expect(下一轮次(轮们, "样品")).toBe(4);
    expect(下一轮次(轮们, "验货")).toBe(2);
    expect(下一轮次([], "验货")).toBe(1);
    expect(最近一轮(轮们, "样品")?.round).toBe(3);
  });
});

describe("样品状态", () => {
  it("标了不适用就是不适用，不看轮次", () => {
    expect(样品状态([{ kind: "样品", round: 1, result: "过" }], true)).toBe("不适用");
  });
  it("没寄 / 寄了没回话 / 各结果", () => {
    expect(样品状态([], false)).toBe("未寄");
    expect(样品状态([{ kind: "样品", round: 1, at: 天后(-3) }], false)).toBe("已寄");
    expect(样品状态([{ kind: "样品", round: 1, result: "过" }], false)).toBe("已过");
    expect(样品状态([{ kind: "样品", round: 1, result: "要改" }], false)).toBe("要改");
    expect(样品状态([{ kind: "样品", round: 1, result: "要改" }, { kind: "样品", round: 2, result: "重打" }], false)).toBe("重打");
  });
  it("验货的轮次不影响样品", () => {
    expect(样品状态([{ kind: "验货", round: 1, result: "过" }], false)).toBe("未寄");
  });
});

describe("到港灯", () => {
  it("没有海运、没填预计到港 = 无", () => {
    expect(到港灯(null, 现在)).toBe("无");
    expect(到港灯({}, 现在)).toBe("无");
  });
  it("已到港 = 绿，哪怕预计到港早过了", () => {
    expect(到港灯({ eta: 天后(-10), ata: 天后(-2) }, 现在)).toBe("绿");
  });
  it("预计到港早于今天还没到 = 红；今天、3 天内 = 黄；更远 = 无", () => {
    expect(到港灯({ eta: 天后(-1) }, 现在)).toBe("红");
    expect(到港灯({ eta: 天后(0, 23) }, 现在)).toBe("黄");
    expect(到港灯({ eta: 天后(3) }, 现在)).toBe("黄");
    expect(到港灯({ eta: 天后(4) }, 现在)).toBe("无");
  });
  it("库里出来的 ISO 串也认", () => {
    expect(到港灯({ eta: 天后(-2).toISOString() }, 现在)).toBe("红");
    expect(到港灯({ eta: 天后(2).toISOString() }, 现在)).toBe("黄");
  });
});

describe("尾款要催", () => {
  it("到港临近或过期、钱没收齐才催", () => {
    expect(尾款要催({ eta: 天后(2) }, 100, 现在)).toBe(true);
    expect(尾款要催({ eta: 天后(-1) }, 100, 现在)).toBe(true);
    expect(尾款要催({ eta: 天后(2) }, 0, 现在)).toBe(false);
    expect(尾款要催({ eta: 天后(10) }, 100, 现在)).toBe(false);
    expect(尾款要催({ eta: 天后(-1), ata: 天后(-1) }, 100, 现在)).toBe(false);
    expect(尾款要催(null, 100, 现在)).toBe(false);
  });
});

describe("我该做的", () => {
  const nodes = [
    { idx: 1, status: "已完成", ownerId: "a" },
    { idx: 2, status: "进行中", ownerId: "a" },
    { idx: 3, status: "未开始", ownerId: "b" },
    { idx: 4, status: "不适用", ownerId: "a" },
    { idx: 5, status: "卡住", ownerId: "a" },
    { idx: 6, status: "未开始", ownerId: null },
  ];
  it("只留我负责、没完成、不是不适用的", () => {
    expect(我该做的(nodes, "a").map((n) => n.idx)).toEqual([2, 5]);
    expect(我该做的(nodes, "b").map((n) => n.idx)).toEqual([3]);
  });
  it("没登录的人（空 id）不会把没指定负责人的节点认成自己的", () => {
    expect(我该做的(nodes, "")).toEqual([]);
  });
});
