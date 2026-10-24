/**
 * 一周模拟的 25 人公司（虚构，按需求文件第四节的组织形态搭）：
 * 总经办 2 人；内贸部（含内贸一组）12 人；外贸部 8 人；市场部 3 人。
 * 7 个业务角色都有人、三类管理员都有人、实线 + 虚线上级都有。
 *
 * User 表两边（main / 企业版）都建；组织表（EntDept / EntMember）只在 schema 里有这两张表时建，
 * 所以同一份公司在开关关的那组里也能用。
 */
import { prisma } from "@/lib/prisma";

export type 人 = {
  key: string;
  /** User.role：ADMIN | MANAGER | SALES */
  role: "ADMIN" | "MANAGER" | "SALES";
  dept: "总经办" | "内贸部" | "内贸一组" | "外贸部" | "市场部";
  bizRole: "director" | "sales_mgr" | "sales" | "project_ops" | "channel_ops" | "marketing_mgr";
  line: "内贸" | "外贸" | null;
  /** 直属上级（显式写，不靠按部门推） */
  上级?: string;
  /** 虚线上级 */
  虚线?: string;
};

const 内 = (key: string, bizRole: 人["bizRole"], dept: 人["dept"], 上级: string, 虚线?: string): 人 =>
  ({ key, role: "SALES", dept, bizRole, line: "内贸", 上级, 虚线 });
const 外 = (key: string, bizRole: 人["bizRole"]): 人 => ({ key, role: "SALES", dept: "外贸部", bizRole, line: "外贸", 上级: "外贸经理" });

export const 人员: 人[] = [
  { key: "老板", role: "ADMIN", dept: "总经办", bizRole: "director", line: null },
  { key: "总管理", role: "MANAGER", dept: "总经办", bizRole: "director", line: null },

  { key: "内贸经理", role: "MANAGER", dept: "内贸部", bizRole: "sales_mgr", line: "内贸", 上级: "总管理" },
  { key: "组长", role: "MANAGER", dept: "内贸一组", bizRole: "sales_mgr", line: "内贸", 上级: "内贸经理" },
  内("内销1", "sales", "内贸一组", "组长"),
  内("内销2", "sales", "内贸一组", "组长"),
  内("内销3", "sales", "内贸一组", "组长"),
  内("内销4", "sales", "内贸部", "内贸经理", "外贸经理"),
  内("内销5", "sales", "内贸部", "内贸经理"),
  内("内销6", "sales", "内贸部", "内贸经理"),
  内("内运1", "project_ops", "内贸部", "内贸经理"),
  内("内运2", "project_ops", "内贸部", "内贸经理"),
  内("内渠1", "channel_ops", "内贸部", "内贸经理", "市场经理"),
  内("内渠2", "channel_ops", "内贸部", "内贸经理", "市场经理"),

  { key: "外贸经理", role: "MANAGER", dept: "外贸部", bizRole: "sales_mgr", line: "外贸", 上级: "总管理" },
  外("外销1", "sales"), 外("外销2", "sales"), 外("外销3", "sales"),
  外("外销4", "sales"), 外("外销5", "sales"), 外("外销6", "sales"),
  外("外运1", "project_ops"),

  { key: "市场经理", role: "MANAGER", dept: "市场部", bizRole: "marketing_mgr", line: null, 上级: "总管理" },
  { key: "市渠1", role: "SALES", dept: "市场部", bizRole: "channel_ops", line: null, 上级: "市场经理" },
  { key: "市渠2", role: "SALES", dept: "市场部", bizRole: "channel_ops", line: null, 上级: "市场经理" },
];

export type 公司 = { id: Record<string, string>; 名: Record<string, string>; 人: Record<string, 人> };

/** 建人；有组织表就连部门、成员一起建。返回 key → userId */
export async function 建公司(): Promise<公司> {
  const id: Record<string, string> = {}, 名: Record<string, string> = {}, 人: Record<string, 人> = {};
  for (const [i, p] of 人员.entries()) {
    const u = await prisma.user.create({
      data: { email: `sim${i}@sim.test`, name: p.key, title: p.bizRole, role: p.role, password: "x" },
    });
    id[p.key] = u.id; 名[u.id] = p.key; 人[p.key] = p;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const db = prisma as any;
  if (db.entDept && db.entMember) {
    const 部门: Record<string, string> = {};
    for (const [n, 父] of [["总经办", null], ["内贸部", null], ["内贸一组", "内贸部"], ["外贸部", null], ["市场部", null]] as const) {
      部门[n] = (await db.entDept.create({ data: { name: n, parentId: 父 ? 部门[父] : null } })).id;
    }
    for (const p of 人员) {
      await db.entMember.create({
        data: {
          userId: id[p.key], deptId: 部门[p.dept], bizRole: p.bizRole, line: p.line,
          managerId: p.上级 ? id[p.上级] : null, dottedManagerId: p.虚线 ? id[p.虚线] : null,
        },
      });
    }
  }
  return { id, 名, 人 };
}
