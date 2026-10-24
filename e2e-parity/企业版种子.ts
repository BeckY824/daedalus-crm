/**
 * 截图对比用的企业版数据：两条组织规则都打开、长名字的部门树、几个销售、线索和分配记录、配额。
 * 企业版自己的页（设置 → 组织架构、线索分配和配额）要有东西画出来，网页和桌面端才比得出差别。
 * 名字故意取长的（中文长部门名、无空格英文名），窄宽度下换行 / 截断两边要一样。
 */
import type { PrismaClient } from "../src/generated/prisma";
import { 规则 } from "../src/lib/enterprise/rules-table";

const 本月 = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

export async function 灌企业版(db: PrismaClient, 我: string) {
  for (const { key } of Object.values(规则)) {
    await db.setting.upsert({ where: { key }, create: { key, value: "true" }, update: { value: "true" } });
  }

  const 总部 = await db.entDept.create({ data: { name: "总部", sort: 0 } });
  const 外贸 = await db.entDept.create({ data: { name: "外贸事业部（欧洲及北美区域大客户开发与维护中心）", parentId: 总部.id, sort: 0 } });
  const 北欧 = await db.entDept.create({ data: { name: "Scandinavia-Benelux-KeyAccounts-Development-Team", parentId: 外贸.id, sort: 0 } });
  const 内贸 = await db.entDept.create({ data: { name: "内贸部", parentId: 总部.id, sort: 1 } });
  const 市场 = await db.entDept.create({ data: { name: "市场部", parentId: 总部.id, sort: 2 } });

  // 只是组织里的人，不登录：密码字段放个占位，登不进任何地方
  const 人 = async (email: string, name: string, title: string, role = "SALES") =>
    (await db.user.create({ data: { email, name, title, role, password: "-" } })).id;
  const 经理 = await 人("parity-mgr", "欧阳·克里斯蒂安森", "外贸销售经理", "MANAGER");
  const 销售甲 = await 人("parity-s1", "Alexandra Montgomery-Fitzwilliam", "外贸销售");
  const 销售乙 = await 人("parity-s2", "司马长风", "内贸销售");
  const 市场人 = await 人("parity-mk", "诸葛晓", "市场专员");

  await db.entMember.createMany({
    data: [
      { userId: 我, deptId: 总部.id, bizRole: "director" },
      { userId: 经理, deptId: 外贸.id, bizRole: "sales_mgr", line: "外贸" },
      { userId: 销售甲, deptId: 北欧.id, bizRole: "sales", line: "外贸", managerId: 经理, dottedManagerId: 我 },
      { userId: 销售乙, deptId: 内贸.id, bizRole: "sales", line: "内贸" },
      { userId: 市场人, deptId: 市场.id, bizRole: "marketing_mgr" },
    ],
  });
  await db.entLeadQuota.createMany({
    data: [
      { userId: 销售甲, quota: 30, setById: 经理 },
      { userId: 销售乙, quota: 5, setById: 我 },
    ],
  });

  const 名们 = [
    "Nordisk Interiør Handelsselskab ApS",
    "VeryLongCompanyNameWithoutAnySpacesHoldingsInternationalLimited",
    "杭州某某家居用品进出口贸易有限公司（滨江分公司）",
    "Brightwell Kitchens",
    "Oslo Møbel AS",
    "宁波海曙区家具城",
  ];
  const 月 = 本月();
  for (let i = 0; i < 24; i++) {
    const 给 = [销售甲, 销售乙, null][i % 3];
    const 线索 = await db.lead.create({
      data: {
        name: `${名们[i % 名们.length]}${i >= 名们.length ? ` ${i}` : ""}`,
        contact: i % 2 ? "Margaretha van der Westhuizen" : "王",
        source: ["官网注册", "展会", "转介绍", "小红书"][i % 4],
        status: ["待跟进", "跟进中", "已放弃"][i % 3],
        ownerId: 给 ?? 市场人,
      },
    });
    if (给) await db.entLeadAssign.create({ data: { leadId: 线索.id, toUserId: 给, fromUserId: 市场人, byUserId: 市场人, line: 给 === 销售甲 ? "外贸" : "内贸", month: 月 } });
  }
}
