/**
 * 设置 → 团队 →「疑似重复」合并成一份（2026-10-20，客户「硕诚包装」：老板和业务员各录了一份同号码的客户）。
 *
 * 接着 09 / 09a / 09b 造的那台：.team.json 一放，「我」按假云端的名单对成老板 / 主管 / 业务员。
 *   - 老板：每组几份的对比（负责人、跟进条数、最近跟进、建档），默认留跟进多的、一样多留先建的，能改选；
 *     全选 / 批量合并（先确认，说清备份和撤销）；合并后各剩一份、跟进挪过来、负责人不变、合并前有备份；撤销一次拆回两份
 *   - 「不是同一个人」：标了就不再列
 *   - 主管看得到这一块；业务员看不到
 * 窗口用桌面端最窄（1024 × 700），名字故意很长，每一屏量一次排版。SHOT_DIR 给了就截几张（PR 用）。
 */
import { test, expect, type Page } from "@playwright/test";
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { 查排版, 说问题 } from "../e2e/layout-audit";
import { DATA_DIR, 云端账号 } from "./env";
import { 设云端团队, 连库, 进门 } from "./helpers";

test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1024, height: 700 } });

const 我id = `acct_${云端账号.id}`;
const 小周id = "acct_acc_zhou";
const 小周 = "小周·华东区域业务经理（新人）";
const 号 = { 甲: "13600000301", 乙: "13600000302", 丙: "13600000303" };
const 名 = {
  甲我: "合并-东莞市硕诚包装材料有限公司华南采购中心",
  甲周: "合并-硕诚包装（小周录的）",
  乙我: "合并-佛山顺德彩印纸箱厂",
  乙周: "合并-顺德彩印（小周先录的）",
  丙我: "合并-同号不同人·张先生",
  丙周: "合并-同号不同人·张太太",
};
const id: Record<string, string> = {};
type 我 = "owner" | "manager" | "member";
const 团队 = (我: 我) => ({
  id: "t_e2e", name: "E2E 团队", active: true, 我是建的人: 我 === "owner", 互看: false,
  成员: [
    { accountId: "acc_boss", name: 我 === "owner" ? "陈业务·华南区域客户经理" : "王老板", contact: "boss@e2e.local", role: 我 === "owner" ? "member" : "owner" },
    { accountId: 云端账号.id, name: 云端账号.name, contact: 云端账号.contact, role: 我 },
    { accountId: "acc_zhou", name: 小周, contact: "zhou@e2e.local", role: "member" },
  ],
});
const 截图 = async (page: Page, 文件: string) => {
  if (!process.env.SHOT_DIR) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(process.env.SHOT_DIR, 文件) });
};
async function 排版没问题(page: Page) {
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  const 问题 = await 查排版(page);
  expect(问题, 说问题(问题)).toEqual([]);
}
async function 对齐(page: Page) {
  await 进门(page, "/settings?tab=team");
  await expect(page.getByRole("tabpanel", { name: /^团队/ }).getByRole("heading", { name: "E2E 团队" })).toBeVisible();
  await page.waitForTimeout(3500);
  await 进门(page, "/settings?tab=team");
}
const 组 = (page: Page, 号码: string) => page.getByTestId("dupe-group").filter({ hasText: 号码 });

test.beforeAll(async ({ request }) => {
  const p = 连库();
  try {
    await p.user.upsert({ where: { id: 小周id }, create: { id: 小周id, email: "zhou@e2e.local", name: 小周, password: "x", role: "SALES", title: "业务员" }, update: { active: true, name: 小周 } });
    const 建 = async (k: string, name: string, phone: string, owner: string, 跟进: number, createdAt: string, extra: Record<string, unknown> = {}) => {
      id[k] = (await p.customer.create({ data: { name, phone, salesOwnerId: owner, createdAt: new Date(createdAt), ...extra } })).id;
      for (let i = 0; i < 跟进; i++) {
        await p.followUp.create({ data: { customerId: id[k], ownerId: owner, type: "CALL", title: "电话", content: `${name} 第 ${i + 1} 次`, status: "已完成", occurredAt: new Date(Date.now() - (i + 1) * 86_400_000) } });
      }
    };
    await 建("甲我", 名.甲我, 号.甲, 我id, 2, "2026-10-10T08:00:00Z", { remark: "老板这份有备注" });
    await 建("甲周", 名.甲周, 号.甲, 小周id, 1, "2026-10-12T08:00:00Z", { major: "纸箱 · 彩盒" });
    await 建("乙周", 名.乙周, 号.乙, 小周id, 1, "2026-10-08T08:00:00Z");
    await 建("乙我", 名.乙我, 号.乙, 我id, 1, "2026-10-15T08:00:00Z");
    await 建("丙我", 名.丙我, 号.丙, 我id, 0, "2026-10-11T08:00:00Z");
    await 建("丙周", 名.丙周, 号.丙, 小周id, 0, "2026-10-13T08:00:00Z");
  } finally {
    await p.$disconnect();
  }
  await 设云端团队(request, 团队("owner"));
  writeFileSync(
    path.join(DATA_DIR, ".team.json"),
    JSON.stringify({ teamId: "t_e2e", teamName: "E2E 团队", joinSecret: "e2e", key: "A".repeat(43), device: "dev_e2e", pulled: 0 }),
    { mode: 0o600 },
  );
});

test.afterAll(async ({ request }) => {
  rmSync(path.join(DATA_DIR, ".team.json"), { force: true });
  await 设云端团队(request, { id: "t_e2e", name: "E2E 团队", active: true, 我是建的人: false, 成员: 团队("member").成员.slice(0, 2) });
  const p = 连库();
  try {
    const ids = Object.values(id);
    await p.customerMerge.deleteMany({ where: { fromId: { in: ids } } });
    await p.customerNotDupe.deleteMany({ where: { customerId: { in: ids } } });
    await p.setting.deleteMany({ where: { key: "customerMergeUndo" } });
    await p.followUp.deleteMany({ where: { customerId: { in: ids } } });
    await p.customer.deleteMany({ where: { id: { in: ids } } });
    await p.user.update({ where: { id: 我id }, data: { role: "ADMIN", active: true } });
    await p.user.updateMany({ where: { id: { not: 我id } }, data: { active: false } });
  } finally {
    await p.$disconnect();
  }
});

test("老板：每组几份的对比，默认留跟进多的、一样多留先建的；能改选", async ({ page }) => {
  await 对齐(page);
  const 卡 = page.getByTestId("team-dupes");
  await expect(卡).toBeVisible();
  await expect(组(page, 号.甲)).toContainText(名.甲我);
  await expect(组(page, 号.甲)).toContainText(名.甲周);
  await expect(组(page, 号.甲)).toContainText(小周);
  await expect(组(page, 号.甲)).toContainText("2 条");
  await expect(组(page, 号.甲)).toContainText("2026-10-10");
  await expect(组(page, 号.丙)).toContainText("没有");
  // 甲：老板那份跟进多 → 默认留它；乙：一样多 → 留先建的（小周那份）
  await expect(组(page, 号.甲).locator("tr.is-keep")).toContainText(名.甲我);
  await expect(组(page, 号.乙).locator("tr.is-keep")).toContainText(名.乙周);
  await 卡.scrollIntoViewIfNeeded();
  await 排版没问题(page);
  await 截图(page, "8-合并-疑似重复对比.png");

  // 乙改留老板那份
  await 组(page, 号.乙).locator("tr").filter({ hasText: 名.乙我 }).locator(".ant-radio-input").check();
  await expect(组(page, 号.乙).locator("tr.is-keep")).toContainText(名.乙我);

  // 全选能勾上、再取消
  await 卡.locator(".dupe-bar .ant-checkbox-input").check();
  await expect(page.getByTestId("dupe-merge-selected")).toContainText(/批量合并（\d+ 组）/);
  await 卡.locator(".dupe-bar .ant-checkbox-input").uncheck();
  await expect(page.getByTestId("dupe-merge-selected")).toBeDisabled();
});

test("老板：勾两组批量合并，先确认；合并后各剩一份、跟进挪过来、负责人不变、合并前有备份", async ({ page }) => {
  await 对齐(page);
  await 组(page, 号.乙).locator("tr").filter({ hasText: 名.乙我 }).locator(".ant-radio-input").check();
  await 组(page, 号.甲).locator(".dupe-group-head .ant-checkbox-input").check();
  await 组(page, 号.乙).locator(".dupe-group-head .ant-checkbox-input").check();
  const 备份前 = existsSync(path.join(DATA_DIR, "backups")) ? readdirSync(path.join(DATA_DIR, "backups")).filter((f) => f.startsWith("before-merge-")).length : 0;
  await page.getByTestId("dupe-merge-selected").click();
  const 确认 = page.getByTestId("dupe-merge-confirm");
  await expect(确认).toContainText("自动备份");
  await expect(确认).toContainText("撤销一次");
  await 截图(page, "9-合并-批量合并确认.png");
  await page.getByRole("button", { name: /^合并 2 组$/ }).click();
  await expect(page.getByText(/合并好了：2 对变成一份/)).toBeVisible();
  await expect(组(page, 号.甲)).toHaveCount(0);
  await expect(组(page, 号.乙)).toHaveCount(0);
  await expect(组(page, 号.丙)).toHaveCount(1);
  await expect(page.getByTestId("dupe-undo")).toContainText("合并了 2 对");
  // 提示条 5 秒后自己收起；收起了再量排版（它浮在页面最上面，量的时候会算成「盖住」）
  await expect(page.locator(".ant-message-notice")).toHaveCount(0, { timeout: 10_000 });
  await page.getByTestId("team-dupes").scrollIntoViewIfNeeded();
  await 排版没问题(page);
  await 截图(page, "10-合并-合并后可撤销.png");

  const p = 连库();
  try {
    expect(await p.customer.count({ where: { phone: 号.甲 } })).toBe(1);
    expect(await p.customer.count({ where: { phone: 号.乙 } })).toBe(1);
    expect(await p.customer.findUniqueOrThrow({ where: { id: id.甲我 } })).toMatchObject({ salesOwnerId: 我id, remark: "老板这份有备注", major: "纸箱 · 彩盒" });
    expect(await p.followUp.count({ where: { customerId: id.甲我 } })).toBe(3);
    expect(await p.customer.findUnique({ where: { id: id.乙周 } })).toBeNull();
    expect(await p.followUp.count({ where: { customerId: id.乙我 } })).toBe(2);
    expect(await p.customerMerge.findUniqueOrThrow({ where: { id: id.甲周 } })).toMatchObject({ intoId: id.甲我, fromOwnerName: 小周 });
    const 日志 = await p.auditLog.findFirstOrThrow({ where: { action: "merge", entityId: id.甲我 }, orderBy: { at: "desc" } });
    expect(日志.summary).toContain(名.甲周);
    expect(日志.summary).toContain(小周);
  } finally {
    await p.$disconnect();
  }
  expect(readdirSync(path.join(DATA_DIR, "backups")).filter((f) => f.startsWith("before-merge-")).length).toBeGreaterThan(Math.min(备份前, 4));
});

test("老板：撤销这次合并，拆回两份、跟进挪回去；撤过就没得撤", async ({ page }) => {
  await 对齐(page);
  await page.getByTestId("dupe-undo").getByRole("button", { name: "撤销这次合并" }).click();
  await page.getByRole("button", { name: /^撤销合并$/ }).click();
  await expect(page.getByText(/撤销好了：2 对拆回两份/)).toBeVisible();
  await expect(page.getByTestId("dupe-undo")).toHaveCount(0);
  await expect(组(page, 号.甲)).toHaveCount(1);
  const p = 连库();
  try {
    expect(await p.customer.findUniqueOrThrow({ where: { id: id.甲周 } })).toMatchObject({ salesOwnerId: 小周id, name: 名.甲周 });
    expect(await p.customer.findUniqueOrThrow({ where: { id: id.甲我 } })).toMatchObject({ major: null });
    expect(await p.followUp.count({ where: { customerId: id.甲周 } })).toBe(1);
    expect(await p.customerMerge.count({ where: { fromId: { in: [id.甲周, id.乙周] } } })).toBe(0);
  } finally {
    await p.$disconnect();
  }
});

test("老板：单独一组标「不是同一个人」，就不再列", async ({ page }) => {
  await 对齐(page);
  await 组(page, 号.丙).getByRole("button", { name: "不是同一个人" }).click();
  await page.getByRole("button", { name: /^不是同一个人$/ }).last().click();
  await expect(page.getByText("记下了，不再列出来")).toBeVisible();
  await expect(组(page, 号.丙)).toHaveCount(0);
  // 单独合并一组也行
  await 组(page, 号.甲).getByRole("button", { name: /^合\s*并$/ }).click();
  await expect(page.getByTestId("dupe-merge-confirm")).toBeVisible();
  await page.locator(".ant-modal-confirm").getByRole("button", { name: /^合\s*并$/ }).click();
  await expect(page.getByText(/合并好了：1 对变成一份/)).toBeVisible();
  await expect(组(page, 号.甲)).toHaveCount(0);
});

test("主管看得到这一块；业务员看不到", async ({ page, request }) => {
  await 设云端团队(request, 团队("manager"));
  await 对齐(page);
  await expect(page.getByTestId("team-dupes")).toBeVisible();
  await expect(组(page, 号.乙)).toHaveCount(1);
  await 排版没问题(page);
  await 设云端团队(request, 团队("member"));
  await 对齐(page);
  await expect(page.getByTestId("team-role-intro")).toContainText("你是业务员");
  await expect(page.getByTestId("team-dupes")).toHaveCount(0);
  await expect(page.getByText("疑似重复")).toHaveCount(0);
});
