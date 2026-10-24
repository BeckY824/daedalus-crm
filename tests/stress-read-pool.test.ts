/**
 * 10-05 卡死的那条压测（tests/stress.test.ts），开着企业版只读通道再跑一遍。
 * stress.test.ts 一行不改、原样引进来：关着的那一遍是它自己，这里是开着的那一遍（lib/read-pool.ts）。
 * 只读通道多开了 4 个连接，要钉住的就是「多连接 + 交互式事务」这回不会再锁死。
 */
import { vi, it, expect, afterAll } from "vitest";

const 原 = vi.hoisted(() => {
  const 原 = { CRM_ENTERPRISE: process.env.CRM_ENTERPRISE, CRM_READ_POOL: process.env.CRM_READ_POOL };
  process.env.CRM_ENTERPRISE = "1";
  delete process.env.CRM_READ_POOL;
  delete process.env.DESKTOP_LOCAL;
  delete process.env.MULTI_TENANT;
  return 原;
});

import "./stress.test";

it("这一遍真的开着只读通道，查询真的走了它", async () => {
  const { 读通道开着 } = await import("@/lib/read-pool");
  expect(读通道开着()).toBe(true);
  expect((globalThis as { __读通道?: unknown }).__读通道).toBeDefined();
});

afterAll(async () => {
  const { 关读通道 } = await import("@/lib/read-pool");
  await 关读通道();
  for (const [k, v] of Object.entries(原)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});
