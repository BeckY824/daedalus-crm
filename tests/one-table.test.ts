import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";

/**
 * 「全站只有一个表格实现」（批 3 的验收）。
 *
 * 七张列表页原本各写各的 `<Table>`：密度、空态、分页、批量操作的写法各不相同，
 * 改一处密度要改七遍，漏一遍就长得不一样。现在它们只写列、筛选、空状态、主动作，
 * 表格本身在 components/DataList.tsx 里。
 *
 * 这条用源码判而不是跑界面：界面上「两张表格长得像」看不出是不是同一份实现，
 * 而这正是要钉住的东西。
 */
const 列表页 = [
  "src/app/(app)/customers/CustomersView.tsx",
  "src/app/(app)/leads/LeadsView.tsx",
  "src/app/(app)/channels/ChannelsView.tsx",
  "src/app/(app)/contacts/ContactsView.tsx",
  "src/app/(app)/opportunities/OpportunitiesView.tsx",
  "src/app/(app)/follow-ups/FollowUpsView.tsx",
];

/**
 * 这几处的表格不是「列表页」：运营台、复盘里的排行、渠道雷达、设置页、导入那两屏。
 *
 * 判据是「它列的是不是库里某一张表的记录」。导入抽屉里那两张列的是
 * **这份文件的列**和**读不懂的格子**——都还没进库，也没有筛选、分页、批量、空态
 * 这些 DataList 存在的理由。硬套 DataList 只会让那个组件长出一堆只有导入用得上的口子。
 */
const 不算列表页 = [
  "src/components/DataList.tsx",
  "src/app/admin/AdminView.tsx",
  "src/app/(app)/reports/ReportsView.tsx",
  "src/app/(app)/channels/ReferralRadar.tsx",
  "src/app/(app)/settings/SettingsView.tsx",
  // 导入记录：列的是导入批次，不是业务记录；只有一颗撤销，没有筛选分页批量
  "src/app/(app)/settings/ImportsTab.tsx",
  // 导入抽屉：一张列文件的列，一张列读不懂的格子。都还没进库
  "src/app/(app)/customers/ImportDrawer.tsx",
];

async function 全部源码(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name === "generated") continue;
      out.push(...(await 全部源码(p)));
    } else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

describe("列表页共用一个表格实现", () => {
  it("六张列表页都走 DataList，自己不碰 antd 的 Table", async () => {
    const 犯规: string[] = [];
    for (const f of 列表页) {
      const src = await readFile(f, "utf8");
      if (/<Table[\s<]/.test(src)) 犯规.push(`${f} 自己渲染了 <Table>`);
      if (!/from "@\/components\/DataList"/.test(src)) 犯规.push(`${f} 没有用 DataList`);
    }
    expect(犯规, 犯规.join("\n")).toEqual([]);
  });

  it("除了那几处不是列表页的，源码里再没有第二个 <Table>", async () => {
    const 多出来的: string[] = [];
    for (const f of await 全部源码("src")) {
      if (不算列表页.includes(f)) continue;
      const src = await readFile(f, "utf8");
      if (/<Table[\s<]/.test(src)) 多出来的.push(f);
    }
    expect(多出来的, `这些地方又长出了一个表格实现：\n${多出来的.join("\n")}`).toEqual([]);
  });

  it("每页的空状态说的是各自的第一步，不是同一句「暂无数据」", async () => {
    const 文案: string[] = [];
    for (const f of 列表页) {
      const src = await readFile(f, "utf8");
      const m = src.match(/空态=\{\{\s*\n?\s*title: ([^\n]+)/);
      expect(m, `${f} 没给空状态`).toBeTruthy();
      文案.push(m![1]);
    }
    expect(new Set(文案).size, `有两页的空状态标题是同一句：${文案.join(" / ")}`).toBe(文案.length);
  });
});
