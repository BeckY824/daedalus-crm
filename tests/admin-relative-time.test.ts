/**
 * 运营台的「多久前」。
 *
 * 钉住的是：**给了基准就只看基准，不看钟**。页面上它拿 OpsShell 的 渲染于 当现在，
 * 服务器渲染和浏览器水合用的是同一个时刻，算出来才一字不差——
 * 要是偷偷又去读 Date.now()，跨过整分钟就一边「刚刚」一边「1 分钟前」，水合报错（PR #7 的 CI 挂过）。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { 何时 } from "@/app/admin/ui";

const 基准 = "2026-10-14T08:00:30.000Z";
const 早 = (毫秒: number) => new Date(new Date(基准).getTime() - 毫秒).toISOString();
const 分 = 60_000;
const 时 = 60 * 分;
const 天 = 24 * 时;

afterEach(() => {
  vi.useRealTimers();
});

describe("何时（带基准）", () => {
  it("按基准分档", () => {
    expect(何时(null, 基准)).toBe("—");
    expect(何时(早(59_000), 基准)).toBe("刚刚");
    expect(何时(早(分), 基准)).toBe("1 分钟前");
    expect(何时(早(59 * 分), 基准)).toBe("59 分钟前");
    expect(何时(早(时), 基准)).toBe("1 小时前");
    expect(何时(早(23 * 时 + 59 * 分), 基准)).toBe("23 小时前");
    expect(何时(早(天), 基准)).toBe("昨天");
    expect(何时(早(29 * 天), 基准)).toBe("29 天前");
    expect(何时("2026-09-01T00:00:00.000Z", 基准)).toBe("2026-09-01");
  });

  it("基准是字符串还是毫秒数，结果一样", () => {
    const iso = 早(5 * 分);
    expect(何时(iso, new Date(基准).getTime())).toBe(何时(iso, 基准));
  });

  it("给了基准，钟走过整分钟也不变——服务器和浏览器才对得上", () => {
    const iso = 早(30_000);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(基准));
    const 服务器 = 何时(iso, 基准);
    vi.setSystemTime(new Date(new Date(基准).getTime() + 90_000)); // 水合晚了一分半
    expect(何时(iso, 基准)).toBe(服务器);
    expect(服务器).toBe("刚刚");
    // 不给基准就是读钟：同一个时间这时已经变了，这正是当初水合不一致的样子
    expect(何时(iso)).toBe("2 分钟前");
  });
});
