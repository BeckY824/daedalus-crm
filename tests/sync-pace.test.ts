/**
 * 人多放慢（2026-10-21 客户 Even 30 人压测的兜底）：云端在范围目录里说 pace（秒），
 * 壳定时来戳（/api/desktop/sync）时没到间隔就跳过；上一轮出错了不放慢；没有 pace（老服务端 / 人少）照旧每戳都同步。
 * 目录里 pace 按人数给，见 sync-scoped-relay.test.ts 最后一条
 */
import { describe, it, expect } from "vitest";
import { 该放慢, type 团队配置 } from "@/lib/sync/client";
import { 前台最短间隔 } from "@/lib/tenant/sync-scoped";

const 现在 = Date.parse("2026-10-21T10:00:00Z");
const 团队 = (x: Partial<团队配置>) => ({ teamId: "t", teamName: "t", joinSecret: "", key: "", device: "d", pulled: 0, ...x }) as 团队配置;
const 秒前 = (s: number) => new Date(现在 - s * 1000).toISOString();

describe("人多放慢", () => {
  it("云端按人数定间隔：不到 10 人不放慢，10 人起 15 秒（有了索引缓存，原来的 20 / 30 秒让老板看到改动超过 20 秒）", () => {
    expect([1, 9, 10, 19, 20, 30, 100].map(前台最短间隔)).toEqual([0, 0, 15, 15, 15, 15, 15]);
  });

  it("没到间隔跳过、到了就同步；壳 8 秒一戳时 20 秒的实际约 24 秒一轮", () => {
    const c = 团队({ pace: 20, lastSyncAt: 秒前(8) });
    expect(该放慢(c, 现在)).toBe(true);
    expect(该放慢({ ...c, lastSyncAt: 秒前(16) }, 现在)).toBe(true);
    expect(该放慢({ ...c, lastSyncAt: 秒前(24) }, 现在)).toBe(false);
    expect(该放慢(团队({ pace: 30, lastSyncAt: 秒前(24) }), 现在)).toBe(true);
    expect(该放慢(团队({ pace: 30, lastSyncAt: 秒前(32) }), 现在)).toBe(false);
    expect(该放慢(团队({ pace: 15, lastSyncAt: 秒前(8) }), 现在)).toBe(true);
    expect(该放慢(团队({ pace: 15, lastSyncAt: 秒前(16) }), 现在)).toBe(false);
  });

  it("没有 pace、从没同步过、上一轮出错、没加入团队：都不放慢", () => {
    expect(该放慢(团队({ lastSyncAt: 秒前(1) }), 现在)).toBe(false);
    expect(该放慢(团队({ pace: 0, lastSyncAt: 秒前(1) }), 现在)).toBe(false);
    expect(该放慢(团队({ pace: 30 }), 现在)).toBe(false);
    expect(该放慢(团队({ pace: 30, lastSyncAt: 秒前(1), lastError: "连不上云端" }), 现在)).toBe(false);
    expect(该放慢(null, 现在)).toBe(false);
  });
});
