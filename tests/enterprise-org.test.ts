/**
 * 企业版组织架构（2026-10-24）：直属 / 虚线上级、下属、管理员三类的纯函数。
 */
import { expect, it } from "vitest";
import { 建组织, 推业务角色, 直属上级of, 虚线上级of, 实线下属, 虚线下属, 管理员类别of, type 组织部门 } from "@/lib/enterprise/org";

const 部门: 组织部门[] = [
  { id: "nei", name: "内贸部", parentId: null, sort: 0 },
  { id: "nei-1", name: "内贸一组", parentId: "nei", sort: 0 },
  { id: "nei-1-a", name: "内贸一组 A", parentId: "nei-1", sort: 0 },
  { id: "wai", name: "外贸部", parentId: null, sort: 1 },
  { id: "loop-1", name: "环 1", parentId: "loop-2", sort: 0 },
  { id: "loop-2", name: "环 2", parentId: "loop-1", sort: 0 },
];
type 行 = { userId: string; deptId?: string | null; bizRole?: string; line?: string | null; managerId?: string | null; dottedManagerId?: string | null };
const 人 = (id: string, role = "SALES", active = true) => ({ id, role, active });
const 行 = (m: 行) => ({ deptId: null, bizRole: "sales", line: null, managerId: null, dottedManagerId: null, ...m });

it("推业务角色：管理员 → 总管理员，主管 → 销售管理，其余和空 → 销售", () => {
  expect(推业务角色("ADMIN")).toBe("director");
  expect(推业务角色("MANAGER")).toBe("sales_mgr");
  expect(推业务角色("SALES")).toBe("sales");
  expect(推业务角色(null)).toBe("sales");
});

it("建组织：停用的人不进；没 EntMember 行按账号角色推；乱填的角色、业务线、删掉的部门都当没填", () => {
  const org = 建组织(
    [人("boss", "ADMIN"), 人("a"), 人("gone", "SALES", false), 人("m", "MANAGER")],
    [行({ userId: "a", deptId: "deleted", bizRole: "ceo", line: "国际" }), 行({ userId: "gone", deptId: "nei" })],
    部门,
  );
  expect([...org.成员.keys()].sort()).toEqual(["a", "boss", "m"]);
  expect(org.成员.get("boss")!.bizRole).toBe("director");
  expect(org.成员.get("m")!.bizRole).toBe("sales_mgr");
  expect(org.成员.get("a")).toMatchObject({ deptId: null, bizRole: "sales", line: null });
});

it("直属上级：显式指定的优先；指定的人停用了、指定自己的都不算", () => {
  const org = 建组织(
    [人("a"), 人("b"), 人("c"), 人("mgr"), 人("off", "SALES", false)],
    [
      行({ userId: "a", deptId: "nei-1", managerId: "b" }),
      行({ userId: "b", deptId: "nei-1", managerId: "off" }),
      行({ userId: "c", deptId: "nei-1", managerId: "c" }),
      行({ userId: "mgr", deptId: "nei-1", bizRole: "sales_mgr" }),
    ],
    部门,
  );
  expect(直属上级of(org, "a")).toBe("b");
  expect(直属上级of(org, "b")).toBe("mgr");
  expect(直属上级of(org, "c")).toBe("mgr");
  expect(直属上级of(org, "nobody")).toBeNull();
});

it("直属上级：没指定就本部门往上找销售管理；几个销售管理取编号最小的；找到顶都没有是 null", () => {
  const org = 建组织(
    [人("s1"), 人("s2"), 人("s3"), 人("z-mgr"), 人("a-mgr"), 人("top-mgr"), 人("boss", "ADMIN")],
    [
      行({ userId: "s1", deptId: "nei-1-a" }),
      行({ userId: "s2", deptId: "nei-1" }),
      行({ userId: "s3", deptId: "wai" }),
      行({ userId: "z-mgr", deptId: "nei-1", bizRole: "sales_mgr" }),
      行({ userId: "a-mgr", deptId: "nei-1", bizRole: "sales_mgr" }),
      行({ userId: "top-mgr", deptId: "nei", bizRole: "sales_mgr" }),
    ],
    部门,
  );
  expect(直属上级of(org, "s1")).toBe("a-mgr"); // 本部门没有，往上一级
  expect(直属上级of(org, "s2")).toBe("a-mgr");
  expect(直属上级of(org, "s3")).toBeNull(); // 外贸部没有销售管理，也不往总管理员上兜
  expect(直属上级of(org, "boss")).toBeNull(); // 没分部门
});

it("直属上级：销售管理自己从上一级部门找，同部门另一个销售管理不算", () => {
  const org = 建组织(
    [人("a-mgr"), 人("z-mgr"), 人("top-mgr")],
    [
      行({ userId: "a-mgr", deptId: "nei-1", bizRole: "sales_mgr" }),
      行({ userId: "z-mgr", deptId: "nei-1", bizRole: "sales_mgr" }),
      行({ userId: "top-mgr", deptId: "nei", bizRole: "sales_mgr" }),
    ],
    部门,
  );
  expect(直属上级of(org, "a-mgr")).toBe("top-mgr");
  expect(直属上级of(org, "z-mgr")).toBe("top-mgr");
  expect(直属上级of(org, "top-mgr")).toBeNull();
});

it("直属上级：部门树成环不转圈", () => {
  const org = 建组织([人("s")], [行({ userId: "s", deptId: "loop-1" })], 部门);
  expect(直属上级of(org, "s")).toBeNull();
});

it("虚线上级：只认显式指定的；停用、指自己 = 没有", () => {
  const org = 建组织(
    [人("a"), 人("b"), 人("c"), 人("off", "SALES", false)],
    [行({ userId: "a", dottedManagerId: "b" }), 行({ userId: "b", dottedManagerId: "off" }), 行({ userId: "c", dottedManagerId: "c" })],
    部门,
  );
  expect(虚线上级of(org, "a")).toBe("b");
  expect(虚线上级of(org, "b")).toBeNull();
  expect(虚线上级of(org, "c")).toBeNull();
});

it("实线下属：整条链往下，层数可限；显式和按部门推出来的都算", () => {
  const org = 建组织(
    [人("top"), 人("mgr"), 人("s1"), 人("s2"), 人("x")],
    [
      行({ userId: "top", deptId: "nei", bizRole: "sales_mgr" }),
      行({ userId: "mgr", deptId: "nei-1", bizRole: "sales_mgr" }),
      行({ userId: "s1", deptId: "nei-1" }),
      行({ userId: "s2", managerId: "s1" }),
      行({ userId: "x", deptId: "wai" }),
    ],
    部门,
  );
  expect([...实线下属(org, "top")].sort()).toEqual(["mgr", "s1", "s2"]);
  expect([...实线下属(org, "top", 1)]).toEqual(["mgr"]);
  expect([...实线下属(org, "s1")]).toEqual(["s2"]);
  expect(实线下属(org, "x").size).toBe(0);
});

it("虚线下属：只顺虚线走，成环不转圈，不含自己", () => {
  const org = 建组织(
    [人("a"), 人("b"), 人("c"), 人("d")],
    [行({ userId: "b", dottedManagerId: "a" }), 行({ userId: "c", dottedManagerId: "b" }), 行({ userId: "a", dottedManagerId: "c" }), 行({ userId: "d", managerId: "a" })],
    部门,
  );
  expect([...虚线下属(org, "a")].sort()).toEqual(["b", "c"]);
  expect([...虚线下属(org, "a", 1)]).toEqual(["b"]);
});

it("管理员三类：总管理员 / 销售管理 / 市场管理；其余角色和不在册的不是管理员", () => {
  const org = 建组织(
    [人("boss", "ADMIN"), 人("adm"), 人("sm"), 人("mm"), 人("s"), 人("ops")],
    [行({ userId: "adm", bizRole: "admin" }), 行({ userId: "sm", bizRole: "sales_mgr" }), 行({ userId: "mm", bizRole: "marketing_mgr" }), 行({ userId: "ops", bizRole: "channel_ops" })],
    部门,
  );
  expect(管理员类别of(org, "boss")).toBe("总管理员");
  expect(管理员类别of(org, "adm")).toBe("总管理员");
  expect(管理员类别of(org, "sm")).toBe("销售管理");
  expect(管理员类别of(org, "mm")).toBe("市场管理");
  expect(管理员类别of(org, "s")).toBeNull();
  expect(管理员类别of(org, "ops")).toBeNull();
  expect(管理员类别of(org, "nobody")).toBeNull();
});
