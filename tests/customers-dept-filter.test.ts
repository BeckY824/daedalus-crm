/**
 * 团队版 1b（2026-10-23）：客户列表「按部门筛」。和云端隔离一个口径——
 * 销售或渠道负责人在这个部门（连下级）里；选默认一级部门时，没分部门的人、负责人不在团队里（已离队）的客户也算
 */
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ 编制: undefined as unknown }));
vi.mock("@/lib/sync/client", async (原) => ({
  ...(await 原<object>()),
  读团队: () => (mocks.编制 ? { teamId: "t", key: "k", device: "d", 编制: mocks.编制 } : null),
}));

import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { 客户筛选条件 } from "@/app/(app)/customers/query";

const 部门 = [
  { id: "nei", name: "内贸", parentId: null, sort: 0, top: "nei" },
  { id: "nei-1", name: "华东", parentId: "nei", sort: 0, top: "nei" },
  { id: "wai", name: "外贸", parentId: null, sort: 1, top: "wai" },
];
const 名单 = (dept: Record<string, string | null>) => Object.fromEntries(Object.entries(dept).map(([a, d]) => [a, { bizRole: "sales", deptId: d, dottedManagerId: null }]));

async function 筛(dept: string) {
  const rows = await prisma.customer.findMany({ where: await 客户筛选条件({ dept }), select: { name: true }, orderBy: { name: "asc" } });
  return rows.map((r) => r.name);
}

beforeEach(async () => {
  await resetDb();
  for (const a of ["a", "b", "c", "gone"]) await prisma.user.create({ data: { id: `acct_${a}`, email: `${a}@local`, name: a, role: "SALES", password: "x" } });
  mocks.编制 = { 部门, 默认: "nei", 角色范围: [], 成员编制: 名单({ a: "nei-1", b: "wai", c: null }) };
  await prisma.customer.createMany({
    data: [
      { name: "1内", phone: "13800000001", salesOwnerId: "acct_a" },
      { name: "2外", phone: "13800000002", salesOwnerId: "acct_b" },
      { name: "3没分部门的人", phone: "13800000003", salesOwnerId: "acct_c" },
      { name: "5离队的人", phone: "13800000005", salesOwnerId: "acct_gone" },
      { name: "6外贸渠道", phone: "13800000006", salesOwnerId: "acct_gone", channelOwnerId: "acct_b" },
    ],
  });
});

it("一级部门连下级；默认一级部门收没分部门的人和无主客户；跨部门的两边都算", async () => {
  expect(await 筛("nei")).toEqual(["1内", "3没分部门的人", "5离队的人"]);
  expect(await 筛("nei-1")).toEqual(["1内"]);
  expect(await 筛("wai")).toEqual(["2外", "6外贸渠道"]);
});

it("没有部门数据（个人版、老云端）、部门已删：不筛", async () => {
  expect(await 筛("gone-dept")).toHaveLength(5);
  mocks.编制 = undefined;
  expect(await 筛("nei")).toHaveLength(5);
});
