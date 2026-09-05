/**
 * 本轮上线前测试中发现并修复的问题，逐条锁死，防止日后重构再次引入。
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { FOLLOW_STATUSES, DECISION_STATUSES } from "../src/lib/constants";
import { readSecret, 密钥最短长度, 开发回落密钥 } from "@/lib/secret";

let sales: { id: string };

beforeEach(async () => {
  await resetDb();
  sales = await prisma.user.create({
    data: { email: "g1", name: "销售", title: "销售", role: "SALES", password: "x" },
  });
});

afterAll(async () => { await prisma.$disconnect(); });

describe("AUTH_SECRET 不得静默回落", () => {
  /**
   * 这里 import 的是 auth.ts 真正在用的那份实现（@/lib/secret）。
   * 早先版本是在测试里照抄一遍 readSecret 再测那个副本——
   * 真身被改坏时那种测试照样绿，等于没有。
   * 之所以能直接 import，是因为 secret.ts 刻意不依赖 next/headers。
   */
  it("生产环境缺少密钥时必须抛错而不是用硬编码默认值", () => {
    expect(() => readSecret({ NODE_ENV: "production" })).toThrow(/AUTH_SECRET/);
    expect(() => readSecret({ NODE_ENV: "production", AUTH_SECRET: "太短" })).toThrow();
    expect(() =>
      readSecret({ NODE_ENV: "production", AUTH_SECRET: "a".repeat(密钥最短长度 - 1) }),
    ).toThrow();
  });

  it("长度达标时原样返回", () => {
    const 密钥 = "a".repeat(64);
    expect(readSecret({ NODE_ENV: "production", AUTH_SECRET: 密钥 })).toBe(密钥);
    // 刚好等于下限也要放行
    expect(readSecret({ NODE_ENV: "production", AUTH_SECRET: "b".repeat(密钥最短长度) })).toHaveLength(密钥最短长度);
  });

  it("开发环境仍可回落，便于本地起服务", () => {
    expect(readSecret({ NODE_ENV: "development" })).toBe(开发回落密钥);
    expect(开发回落密钥.length).toBeGreaterThan(0);
  });

  it("auth.ts 用的就是这份实现，没有各写一份", async () => {
    const fs = await import("node:fs/promises");
    const auth = await fs.readFile("src/lib/auth.ts", "utf8");
    expect(auth).toContain('from "./secret"');
    expect(auth, "auth.ts 里不该再有第二份密钥校验逻辑").not.toContain("dev-only-secret");
  });
});

describe("构建期也必须能拿到 AUTH_SECRET", () => {
  it("Dockerfile 的构建阶段要给 AUTH_SECRET 占位值，否则镜像构建会失败", async () => {
    /**
     * auth.ts 在模块顶层就校验密钥，而 `next build` 跑的就是 NODE_ENV=production。
     * 构建阶段不给值的话，所有 import 了 requireUser 的页面会在
     * 「collect page data」阶段失败，报错只说某个路由挂了、完全不提密钥——
     * 2026-08-29 的一次部署就是这么挂的，本地构建却一直是绿的
     * （因为 .env 里有开发密钥，而 .env 在 .dockerignore 里）。
     */
    const fs = await import("node:fs/promises");
    const dockerfile = await fs.readFile("Dockerfile", "utf8");
    const 构建段 = dockerfile.slice(dockerfile.indexOf("AS builder"), dockerfile.indexOf("AS runner"));
    const 占位 = 构建段.match(/ENV AUTH_SECRET="([^"]+)"/)?.[1];

    expect(占位, "构建阶段缺少 AUTH_SECRET 占位值").toBeTruthy();
    expect(占位!.length, "占位值也要满足 32 位下限，否则一样过不了校验").toBeGreaterThanOrEqual(32);

    // 占位值绝不能出现在运行阶段——运行时必须由 compose 注入真实密钥
    const 运行段 = dockerfile.slice(dockerfile.indexOf("AS runner"));
    expect(运行段).not.toContain("AUTH_SECRET");
  });
});

describe("数据首页不许出现编出来的数字", () => {
  /**
   * 「假数字比没有数字更糟」——数据首页上的数是拿来做判断的。
   * 这条曾经真的漏过：三条小曲线里有一条一直是写死的数组
   * [12,18,15,24,...]，线上零数据时照样画出一条漂亮的上升线，
   * 是看线上截图才发现的。源码级挡住最直接。
   */
  /** 去掉注释再检查——注释里会引用这些写法来说明「原本是怎么错的」 */
  async function 去注释的源码() {
    const fs = await import("node:fs/promises");
    const src = await fs.readFile("src/app/(app)/dashboard/DashboardView.tsx", "utf8");
    return src
      .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "") // JSX 里的 {/* ... */}
      .replace(/\/\*[\s\S]*?\*\//g, "")               // 普通块注释
      .replace(/\/\/.*$/gm, "");                        // 行注释
  }

  it("Sparkline 不许传写死的数组", async () => {
    const 写死的 = [...(await 去注释的源码()).matchAll(/<Sparkline\s+data=\{\[/g)];
    expect(写死的, "有 Sparkline 直接写了数组字面量，应当传真实计算出来的序列").toHaveLength(0);
  });

  it("StatCard 的 delta 不许传字面量", async () => {
    // delta={18.6} 这种；delta={stats.xxx} 是允许的
    const 写死的 = [...(await 去注释的源码()).matchAll(/delta=\{[\d.]+\}/g)].map((m) => m[0]);
    expect(写死的, `涨跌被写死了：${写死的.join(", ")}`).toEqual([]);
  });
});

describe("删除保护：被引用的学员不能删", () => {
  it("查得出哪些学员是他人的推荐来源或归属对象", async () => {
    const g1 = await prisma.customer.create({
      data: { name: "上游", phone: "1", salesOwnerId: sales.id },
    });
    await prisma.customer.create({
      data: { name: "下游", phone: "2", salesOwnerId: sales.id, referrerCustomerId: g1.id },
    });
    await prisma.customer.create({
      data: { name: "归属于上游的", phone: "3", salesOwnerId: sales.id, attributionCustomerId: g1.id },
    });

    const referenced = await prisma.customer.findMany({
      where: {
        id: { in: [g1.id] },
        OR: [{ referrals: { some: {} } }, { attributedCustomers: { some: {} } }],
      },
      select: { name: true, _count: { select: { referrals: true, attributedCustomers: true } } },
    });
    expect(referenced).toHaveLength(1);
    expect(referenced[0]._count.referrals).toBe(1);
    expect(referenced[0]._count.attributedCustomers).toBe(1);
  });

  it("没有被引用的学员不在保护名单里", async () => {
    const solo = await prisma.customer.create({
      data: { name: "孤立学员", phone: "9", salesOwnerId: sales.id },
    });
    const referenced = await prisma.customer.findMany({
      where: {
        id: { in: [solo.id] },
        OR: [{ referrals: { some: {} } }, { attributedCustomers: { some: {} } }],
      },
    });
    expect(referenced).toHaveLength(0);
  });
});

describe("枚举白名单", () => {
  it("跟进状态与决策状态的取值集合非空且互不重叠", () => {
    expect(FOLLOW_STATUSES.length).toBeGreaterThan(0);
    expect(DECISION_STATUSES.length).toBeGreaterThan(0);
    const overlap = FOLLOW_STATUSES.filter((s) => (DECISION_STATUSES as readonly string[]).includes(s));
    expect(overlap).toHaveLength(0);
  });

  it("校验逻辑能挡住枚举外的值", () => {
    const ok = (v: string) => FOLLOW_STATUSES.includes(v as (typeof FOLLOW_STATUSES)[number]);
    expect(ok("已签约")).toBe(true);
    expect(ok("随便写的状态")).toBe(false);
    expect(ok("")).toBe(false);
  });
});

describe("签约金额", () => {
  it("非正数金额应被拒绝", () => {
    const valid = (n: number) => Number.isFinite(n) && n > 0;
    expect(valid(19800)).toBe(true);
    expect(valid(0)).toBe(false);
    expect(valid(-5000)).toBe(false);
    expect(valid(NaN)).toBe(false);
  });
});
