/**
 * 团队版项目模式 1b（2026-10-23）：部门、角色、范围的纯函数。中继那一半在 sync-scoped-dept.test.ts
 */
import { expect, it } from "vitest";
import { 一级部门表, 默认一级部门, 部门判定, 读写档, 推业务角色, 老角色, 默认范围, 部门里的人, 摊平部门 } from "@/lib/sync/dept-policy";
import { 范围可读, type 范围 } from "@/lib/sync/scope-policy";

const t = (n: number) => new Date(2026, 9, 23, 0, n);
const depts = [
  { id: "nei", parentId: null, createdAt: t(1) },
  { id: "nei-1", parentId: "nei", createdAt: t(2) },
  { id: "nei-1-a", parentId: "nei-1", createdAt: t(3) },
  { id: "wai", parentId: null, createdAt: t(4) },
  { id: "loop-1", parentId: "loop-2", createdAt: t(5) },
  { id: "loop-2", parentId: "loop-1", createdAt: t(6) },
  { id: "dangling", parentId: "gone", createdAt: t(7) },
];
const 范 = (id: string, owners: string[], pub = false): 范围 => ({ id, owners, public: pub, routeSeq: 1 });

it("一级部门表：顺着上级走到顶；成环、断链的不算在任何部门", () => {
  const m = 一级部门表(depts);
  expect(Object.fromEntries(m)).toEqual({ nei: "nei", "nei-1": "nei", "nei-1-a": "nei", wai: "wai" });
});

it("默认一级部门：建得最早的；没有一级部门是 null", () => {
  expect(默认一级部门(depts)).toBe("nei");
  expect(默认一级部门([{ id: "b", parentId: null, createdAt: t(1) }, { id: "a", parentId: null, createdAt: t(1) }])).toBe("a");
  expect(默认一级部门([])).toBeNull();
});

it("部门判定：少于两个一级部门、全公司范围都不隔离", () => {
  const members = [{ accountId: "a", deptId: "nei-1-a" }, { accountId: "b", deptId: "wai" }];
  expect(部门判定({ 我: "a", 我的范围: "dept", depts: depts.filter((d) => d.id !== "wai"), members })).toBeUndefined();
  expect(部门判定({ 我: "a", 我的范围: "all", depts, members })).toBeUndefined();
});

it("部门判定：按负责人的一级部门；没部门的人、没负责人的算默认部门；team 永远在", () => {
  const members = [{ accountId: "a", deptId: "nei-1-a" }, { accountId: "b", deptId: "wai" }, { accountId: "c", deptId: null }];
  const 内 = 部门判定({ 我: "a", 我的范围: "self_share", depts, members })!;
  const 外 = 部门判定({ 我: "b", 我的范围: "dept", depts, members })!;
  expect(内(范("Customer:1", ["acct_a"]))).toBe(true);
  expect(内(范("Customer:2", ["acct_b"]))).toBe(false);
  expect(外(范("Customer:2", ["acct_b"]))).toBe(true);
  // 没分部门的老成员、离队的人、没负责人：算建得最早的「内」
  expect(内(范("Customer:3", ["acct_c"]))).toBe(true);
  expect(外(范("Customer:3", ["acct_c"]))).toBe(false);
  expect(内(范("Customer:4", []))).toBe(true);
  expect(外(范("Customer:4", ["acct_离队的"]))).toBe(false);
  // 销售、渠道负责人分在两个部门：两边都算
  expect(内(范("Customer:5", ["acct_a", "acct_b"]))).toBe(true);
  expect(外(范("Customer:5", ["acct_a", "acct_b"]))).toBe(true);
  expect(外(范("team", [], true))).toBe(true);
});

it("读写档：老板照旧；全公司 = 原来的主管；本部门带判定；本人 + 直属下属这一版按本人", () => {
  const 判 = () => true;
  expect(读写档({ 建的人: true, 范围: "self", 互看开关: true, 部门: 判 })).toEqual({ owner: true, manager: false, share: true });
  expect(读写档({ 建的人: false, 范围: "all", 互看开关: false, 部门: 判 })).toEqual({ owner: false, manager: true, share: false });
  expect(读写档({ 建的人: false, 范围: "dept", 互看开关: true, 部门: 判 })).toEqual({ owner: false, manager: true, share: true, 部门: 判 });
  expect(读写档({ 建的人: false, 范围: "self_share", 互看开关: true, 部门: 判 })).toEqual({ owner: false, manager: false, share: true, 部门: 判 });
  expect(读写档({ 建的人: false, 范围: "self_reports", 互看开关: true, 部门: 判 })).toEqual({ owner: false, manager: false, share: false, 部门: 判 });
});

it("老角色互推：默认值等于现在的行为", () => {
  expect(推业务角色(true, "member")).toBe("director");
  expect(推业务角色(false, "manager")).toBe("sales_mgr");
  expect(推业务角色(false, "member")).toBe("sales");
  expect(推业务角色(false, null)).toBe("sales");
  expect([老角色("director"), 老角色("admin"), 老角色("sales_mgr"), 老角色("sales"), 老角色("project_ops")]).toEqual(["manager", "manager", "manager", "member", "member"]);
  expect(默认范围).toMatchObject({ director: "all", admin: "all", sales_mgr: "dept", sales: "self_share" });
});

it("范围可读：进组的项目能读；公海、互看都要在本部门；自己名下的永远能读", () => {
  const 外 = (s: 范围) => s.owners.includes("acct_b");
  const 项目 = 范("Project:p1", ["acct_b"]);
  expect(范围可读(项目, "a", false, false, { 部门: 外 })).toBe(false);
  expect(范围可读(项目, "a", false, false, { 部门: () => false, 进组: new Set(["Project:p1"]) })).toBe(true);
  expect(范围可读(范("Customer:pool", ["acct_b"], true), "a", false, false, { 部门: () => false })).toBe(false);
  expect(范围可读(范("Customer:pool", ["acct_b"], true), "a", false, false, { 部门: () => true })).toBe(true);
  expect(范围可读(范("Customer:x", ["acct_b"]), "a", false, true, { 部门: () => false })).toBe(false);
  expect(范围可读(范("Customer:x", ["acct_b"]), "a", false, true, { 部门: () => true })).toBe(true);
  expect(范围可读(范("Customer:mine", ["acct_a"]), "a", false, false, { 部门: () => false })).toBe(true);
  expect(范围可读(范("team", [], true), "a", false, false, { 部门: () => false })).toBe(true);
  // 不传限 = 原来的行为
  expect(范围可读(范("Customer:x", ["acct_b"]), "a", false, true)).toBe(true);
});

it("部门里的人：连下级；选默认一级部门时没分部门、部门断链的人和无主客户都算（和隔离一个口径）", () => {
  const 部门 = [
    { id: "nei", name: "内贸", parentId: null, sort: 0, top: "nei" },
    { id: "nei-1", name: "华东", parentId: "nei", sort: 0, top: "nei" },
    { id: "wai", name: "外贸", parentId: null, sort: 1, top: "wai" },
    { id: "bad", name: "坏的", parentId: "gone", sort: 0, top: null },
  ];
  const 成员编制 = { a: { deptId: "nei-1" }, b: { deptId: "wai" }, c: { deptId: null }, d: { deptId: "bad" } };
  const 编制 = { 部门, 默认: "nei", 成员编制 };
  expect(部门里的人(编制, "nei")).toEqual({ 人: ["a", "c", "d"], 全员: ["a", "b", "c", "d"], 含无主: true });
  expect(部门里的人(编制, "nei-1")).toMatchObject({ 人: ["a"], 含无主: false });
  expect(部门里的人(编制, "wai")).toMatchObject({ 人: ["b"], 含无主: false });
  expect(摊平部门(部门).map((x) => `${x.层}${x.d.name}`)).toEqual(["1内贸", "2华东", "1外贸", "1坏的"]);
});
