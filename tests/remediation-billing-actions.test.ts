import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  tenant: { workspaceId: "qa-workspace", slug: "qa-team", role: "OWNER", writable: true },
  read: vi.fn(),
  write: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ requireUser: async () => ({ id: "qa-owner" }) }));
vi.mock("@/lib/tenant/context", () => ({ multiTenant: () => true }));
vi.mock("@/lib/tenant/resolve", () => ({ resolveCurrentTenant: async () => state.tenant }));
vi.mock("@/lib/tenant/control", () => ({ control: { workspace: { findUnique: state.read, update: state.write } } }));

import { submitPayment } from "@/app/(app)/billing/actions";

beforeEach(() => {
  vi.stubEnv("SHARED_WORKSPACE", "qa-shared");
  state.tenant = { workspaceId: "qa-workspace", slug: "qa-team", role: "OWNER", writable: true };
  state.read.mockReset().mockResolvedValue({ id: "qa-workspace", note: "QA-original-note" });
  state.write.mockReset().mockResolvedValue({});
});
afterEach(() => vi.unstubAllEnvs());

describe("H-038 账单服务端入口", () => {
  it("共享账号即便是OWNER也不允许写控制面付款备注", async () => {
    state.tenant.slug = "qa-shared";
    expect(await submitPayment({ plan: "year", reference: "QA-reference" })).toMatchObject({ ok: false });
    expect(state.write).not.toHaveBeenCalled();
  });

  it("非创建者不能提交", async () => {
    state.tenant.role = "MEMBER";
    expect(await submitPayment({ plan: "year", reference: "QA-reference" })).toMatchObject({ ok: false });
    expect(state.write).not.toHaveBeenCalled();
  });

  it.each([null, {}, { plan: "year", reference: 1234 }, { plan: "year", reference: [] }])("异常参数返回可处理错误：%j", async (input) => {
    expect(await submitPayment(input as unknown as Parameters<typeof submitPayment>[0])).toMatchObject({ ok: false });
    expect(state.write).not.toHaveBeenCalled();
  });

  it("独立工作区创建者仍能提交待核对信息，不自动开通", async () => {
    expect(await submitPayment({ plan: "month", reference: " QA-reference " })).toEqual({ ok: true });
    expect(state.write).toHaveBeenCalledOnce();
    const data = state.write.mock.calls[0][0].data;
    expect(Object.keys(data)).toEqual(["note"]);
    expect(data.note).toContain("QA-original-note");
    expect(data.note).toContain("QA-reference");
  });
});
