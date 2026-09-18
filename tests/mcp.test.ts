/**
 * MCP 接口：别人的 agent（Claude Code / Codex）连进来查这个 CRM。
 *
 * 这一组盯三件事，每一件都是「开了一个对外的口子」之后最容易出事的地方：
 *   1. 没令牌 / 错令牌一律进不来，比对是常数时间的
 *   2. 开出去的**只有只读那九个**——propose_* 一个都不能在名单里，
 *      否则「AI 只起草、人才落库」这条规矩就从后门绕掉了
 *   3. 协议的形要对：initialize 回能力、tools/list 回 JSON Schema、
 *      工具自己出的错回 isError 的结果而不是 JSON-RPC 的 error
 */
import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 处理 } from "@/lib/mcp/rpc";
import { 列工具, MCP_TOOL_NAMES } from "@/lib/mcp/tools";
import { 生成令牌, 认令牌, 撤销令牌, 读令牌 } from "@/lib/mcp/token";

let 我: { id: string; name: string };

beforeEach(async () => {
  await resetDb();
  我 = await prisma.user.create({ data: { email: "jia", name: "甲", title: "销售", role: "ADMIN", password: "x" }, select: { id: true, name: true } });
});

afterAll(async () => { await prisma.$disconnect(); });

describe("令牌", () => {
  it("生成一把，拿它能换回是谁", async () => {
    const t = await 生成令牌(我.id);
    expect(t.token.startsWith("dcrm_")).toBe(true);
    expect((await 认令牌(t.token))?.id).toBe(我.id);
  });

  it("空的、错的、长度不一样的都不认", async () => {
    await 生成令牌(我.id);
    for (const 坏 of ["", null, undefined, "dcrm_不是这把", "x"]) {
      expect(await 认令牌(坏 as string)).toBeNull();
    }
  });

  it("重新生成一次，旧的立刻作废——钥匙给错人时只有这一条路", async () => {
    const 旧 = await 生成令牌(我.id);
    const 新 = await 生成令牌(我.id);
    expect(await 认令牌(旧.token)).toBeNull();
    expect((await 认令牌(新.token))?.id).toBe(我.id);
  });

  it("撤销之后谁也进不来", async () => {
    const t = await 生成令牌(我.id);
    await 撤销令牌();
    expect(await 读令牌()).toBeNull();
    expect(await 认令牌(t.token)).toBeNull();
  });

  it("生成令牌的人被停用，这把钥匙跟着作废", async () => {
    const t = await 生成令牌(我.id);
    await prisma.user.update({ where: { id: 我.id }, data: { active: false } });
    expect(await 认令牌(t.token)).toBeNull();
  });
});

describe("开出去的工具", () => {
  it("只有只读那九个，propose_* 一个都没有", () => {
    const 名字 = 列工具().map((t) => t.name);
    expect(名字.sort()).toEqual([...MCP_TOOL_NAMES].sort());
    expect(名字.some((n) => n.startsWith("propose_"))).toBe(false);
    expect(名字).toContain("list_channels");
    expect(名字.length).toBe(9);
  });

  it("每个工具都带说明和 JSON Schema——客户端拿它做补全和校验", () => {
    for (const t of 列工具()) {
      expect(t.description.length, `${t.name} 没说明`).toBeGreaterThan(10);
      expect(t.inputSchema.type).toBe("object");
      // 不许偷懒写成「什么都收」：那样对面只能瞎猜参数
      expect(t.inputSchema.additionalProperties).toBe(false);
    }
  });
});

describe("协议", () => {
  const 问 = (method: string, params?: Record<string, unknown>, id: number | null = 1) =>
    处理({ jsonrpc: "2.0", id, method, params }, 我, "0.0.0-test");

  it("initialize：报能力、报版本，并跟着客户端的协议版本走", async () => {
    const r = (await 问("initialize", { protocolVersion: "2025-03-26" })) as { result: Record<string, unknown> };
    expect(r.result.protocolVersion).toBe("2025-03-26");
    expect((r.result.capabilities as { tools?: unknown }).tools).toBeTruthy();
    expect((r.result.serverInfo as { name: string }).name).toBe("daedalus-crm");
    // 认不出来的版本回我们支持的那个，而不是原样附和
    const r2 = (await 问("initialize", { protocolVersion: "1999-01-01" })) as { result: { protocolVersion: string } };
    expect(r2.result.protocolVersion).toBe("2025-06-18");
  });

  it("说明里要写清「写不了东西」——这是客户端会直接显示给人看的一段", async () => {
    const r = (await 问("initialize", {})) as { result: { instructions: string } };
    expect(r.result.instructions).toContain("只读");
    expect(r.result.instructions).toMatch(/写不了/);
  });

  it("通知不回任何东西", async () => {
    expect(await 处理({ jsonrpc: "2.0", method: "notifications/initialized" }, 我, "t")).toBeNull();
  });

  it("tools/call 真的跑到库里去了", async () => {
    await prisma.channel.create({ data: { name: "小红书", channelOwnerId: 我.id } });
    const r = (await 问("tools/call", { name: "list_channels", arguments: {} })) as {
      result: { isError: boolean; structuredContent: { summary: string; data: unknown } };
    };
    expect(r.result.isError).toBe(false);
    expect(r.result.structuredContent.summary).toContain("1 个渠道");
    expect(JSON.stringify(r.result.structuredContent.data)).toContain("小红书");
  });

  it("调一个不存在的工具：回 isError 的结果，不是协议错误", async () => {
    const r = (await 问("tools/call", { name: "rm_rf", arguments: {} })) as { result: { isError: boolean } };
    expect(r.result.isError).toBe(true);
  });

  it("调一个存在但没开出去的工具（propose_*）也进不来", async () => {
    const r = (await 问("tools/call", { name: "propose_followup", arguments: { id: "x" } })) as { result: { isError: boolean } };
    expect(r.result.isError).toBe(true);
  });

  it("不认识的方法回 -32601", async () => {
    const r = (await 问("resources/list")) as { error: { code: number } };
    expect(r.error.code).toBe(-32601);
  });
});
