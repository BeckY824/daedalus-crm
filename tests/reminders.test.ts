/**
 * 桌面端提醒那份摘要（lib/reminders.ts）和它的接口（/api/desktop/reminders）。
 *
 * 钉三件事：
 *   1. **口径和「跟进计划」页一致**——Dock 写 5、点进去只看见 3 个，人就再也不信那个数了
 *   2. 只选了日期（零点）的不算「定了钟点」，不会在半夜十二点叫人
 *   3. 接口只认壳的启动令牌：它不要会话就吐出人名和计划，门必须钉死（同 desktop-session 那组）
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { 算提醒, 定了时刻, type 提醒项 } from "@/lib/reminders";

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
}));

/** 2026-09-28（周一）下午 3 点，本机时区 */
const 现在 = new Date(2026, 8, 28, 15, 0);
const 项 = (id: string, 时间: Date | null, 客户 = "王总"): 提醒项 => ({ id, kind: "plan", 标题: `计划${id}`, 时间, customerId: `c-${id}`, 客户, 方式: "电话沟通" });

describe("逾期 / 今天：和跟进计划页一个口径", () => {
  it("早于今天零点是逾期；今天之内（哪怕钟点已经过了）是今天；明天的不算", () => {
    const r = 算提醒(
      [
        项("a", new Date(2026, 8, 25, 10, 0)), // 三天前
        项("b", new Date(2026, 8, 27, 23, 59)), // 昨天夜里
        项("c", new Date(2026, 8, 28, 9, 0)), // 今天上午，已经过了
        项("d", new Date(2026, 8, 28, 0, 0)), // 今天，只选了日期
        项("e", new Date(2026, 8, 29, 9, 0)), // 明天
        项("f", null), // 没排期
      ],
      现在,
    );
    expect(r.逾期).toBe(2);
    expect(r.今天).toBe(2);
  });

  it("点名最久的那一个，天数按日历天算", () => {
    const r = 算提醒([项("a", new Date(2026, 8, 25, 18, 0), "李娜"), 项("b", new Date(2026, 8, 27, 9, 0), "王强")], 现在);
    expect(r.最久).toEqual({ 客户: "李娜", 天: 3 });
  });

  it("没有逾期的，最久就是 null——早报据此说「还没有逾期的」", () => {
    expect(算提醒([项("a", new Date(2026, 8, 28, 18, 0))], 现在).最久).toBeNull();
  });
});

describe("定了钟点的才到点提醒", () => {
  it("零点 = 只选了日期，不算；其余都算", () => {
    expect(定了时刻(new Date(2026, 8, 28, 0, 0))).toBe(false);
    expect(定了时刻(new Date(2026, 8, 28, 0, 30))).toBe(true);
    expect(定了时刻(new Date(2026, 8, 28, 15, 0))).toBe(true);
  });

  it("只给 10 分钟前到往后 24 小时的；只选了日期的、早就过了的都不给", () => {
    const r = 算提醒(
      [
        项("刚到", new Date(2026, 8, 28, 14, 55)),
        项("早过了", new Date(2026, 8, 28, 9, 0)),
        项("晚上", new Date(2026, 8, 28, 20, 0)),
        项("明早", new Date(2026, 8, 29, 9, 30)),
        项("后天", new Date(2026, 8, 30, 16, 0)),
        项("只有日期", new Date(2026, 8, 29, 0, 0)),
      ],
      现在,
    );
    expect(r.定时.map((x) => x.key)).toEqual(["plan:刚到", "plan:晚上", "plan:明早"]);
    expect(r.定时[0]).toMatchObject({ 客户: "王总", 方式: "电话沟通", customerId: "c-刚到" });
  });
});

describe("接口的门：只认壳的启动令牌", () => {
  const URL_ = "http://127.0.0.1:1234/api/desktop/reminders";
  afterEach(() => {
    delete process.env.DESKTOP_LOCAL;
    delete process.env.DESKTOP_TOKEN;
  });

  it("不是桌面端本地模式 → 404（自部署、托管版的构建里也有这个文件）", async () => {
    const { GET } = await import("@/app/api/desktop/reminders/route");
    process.env.DESKTOP_TOKEN = "desktop-token-for-tests";
    expect((await GET(new Request(URL_, { headers: { "x-desktop-token": "desktop-token-for-tests" } }))).status).toBe(404);
  });

  it("开了开关没有令牌 → 404，不能退化成谁来都给", async () => {
    process.env.DESKTOP_LOCAL = "1";
    const { GET } = await import("@/app/api/desktop/reminders/route");
    expect((await GET(new Request(URL_))).status).toBe(404);
  });

  it("令牌不对、不带、长度不同都是 403，且不会因为长度不同而抛错", async () => {
    process.env.DESKTOP_LOCAL = "1";
    process.env.DESKTOP_TOKEN = "desktop-token-for-tests";
    const { GET } = await import("@/app/api/desktop/reminders/route");
    for (const t of [null, "", "x", "desktop-token-for-testt", "desktop-token-for-testsX"]) {
      const res = await GET(new Request(URL_, { headers: t === null ? {} : { "x-desktop-token": t } }));
      expect(res.status, `令牌 ${JSON.stringify(t)} 不该放行`).toBe(403);
    }
  });

  it("令牌放在网址上不认：会话那条路是 ?t=，这条只认请求头——网址会进日志", async () => {
    process.env.DESKTOP_LOCAL = "1";
    process.env.DESKTOP_TOKEN = "desktop-token-for-tests";
    const { GET } = await import("@/app/api/desktop/reminders/route");
    expect((await GET(new Request(`${URL_}?t=desktop-token-for-tests`))).status).toBe(403);
  });
});
