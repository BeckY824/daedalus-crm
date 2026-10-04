/**
 * 团队版两档权限（lib/team-scope.ts，2026-10-04 拍板）：老板看全部；业务员只看自己负责的（销售负责人或渠道负责人是自己）+ 公海。
 *
 * 一个进程造一台「业务员的电脑」——不用真开两台、也不用走建团队 / 邀请码那条加密链路：
 *   - 数据目录里有 .team.json（在团队() 只看这个文件在不在）
 *   - 库里有 acct_<我的云端账号> 这一行（进团队时改身份改成的 id，lib/desktop/me.ts 的 本机我 认它）
 *   - 同事（老板）的账号 acct_acc_boss 也同步进来了
 *   - 中转的成员名单（假云端 /api/sync/team）说：acc_boss 是 owner，我是 member
 * 角色不同步、每台按名单自己对：我这一行先造成 ADMIN，看它被对成 SALES——那一下走的是真代码（团队状态 → 按名单对角色）。
 *
 * 必须放在最后一组：进了团队之后「我」就换成了业务员，前面那些按管理员写的用例都不成立了。
 * 收尾把 .team.json 挪掉、两个账号停用，「我」回到原来那位管理员。
 */
import { test, expect } from "@playwright/test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CLOUD_URL, DATA_DIR, 云端账号 } from "./env";
import { 设云端团队, 连库, 进门 } from "./helpers";

test.describe.configure({ mode: "serial" });

const 我id = `acct_${云端账号.id}`;
const 老板id = "acct_acc_boss";
const 团队 = {
  id: "t_e2e",
  name: "E2E 团队",
  active: true,
  我是建的人: false,
  成员: [
    { accountId: "acc_boss", name: "王老板", contact: "boss@e2e.local", role: "owner" },
    { accountId: 云端账号.id, name: 云端账号.name, contact: 云端账号.contact, role: "member" },
  ],
};
const 名 = { 我的: "权限-我的客户", 渠道是我: "权限-我带来的", 公海: "权限-公海客户", 老板的: "权限-老板的客户" };
const id: Record<string, string> = {};

test.beforeAll(async ({ request }) => {
  const p = 连库();
  try {
    // 我这一行先是 ADMIN：进团队前本机就是管理员，角色要等对过名单才变（见文件头）
    await p.user.create({ data: { id: 我id, email: "me@e2e.local", name: "林小雨（团队）", password: "x", role: "ADMIN", title: "管理员" } });
    await p.user.create({ data: { id: 老板id, email: "boss@e2e.local", name: "王老板", password: "x", role: "ADMIN", title: "老板" } });
    id.我的 = (await p.customer.create({ data: { name: 名.我的, phone: "13600000001", salesOwnerId: 我id } })).id;
    id.渠道是我 = (await p.customer.create({ data: { name: 名.渠道是我, phone: "13600000002", salesOwnerId: 老板id, channelOwnerId: 我id } })).id;
    id.公海 = (await p.customer.create({ data: { name: 名.公海, phone: "13600000003", salesOwnerId: 老板id } })).id;
    await p.customerPool.create({ data: { customerId: id.公海, reason: "手动" } });
    id.老板的 = (await p.customer.create({ data: { name: 名.老板的, phone: "13600000004", salesOwnerId: 老板id } })).id;
    // 老板的客户上挂一笔跟进：业务员的跟进记录页里也不该看到
    await p.followUp.create({ data: { customerId: id.老板的, ownerId: 老板id, type: "CALL", title: "电话", content: "老板亲自谈的价", status: "已完成", occurredAt: new Date() } });
    // 4.2 其余几处要看的：联系人、计划、商机、签约——老板客户上的一份、我的客户上一份
    await p.contact.create({ data: { customerId: id.老板的, name: "老板客户的联系人", phone: "13600000014" } });
    await p.contact.create({ data: { customerId: id.我的, name: "我客户的联系人", phone: "13600000011" } });
    await p.followPlan.create({ data: { customerId: id.老板的, ownerId: 老板id, subject: "老板的回访计划", plannedAt: new Date(Date.now() + 86_400_000) } });
    await p.followPlan.create({ data: { customerId: id.我的, ownerId: 我id, subject: "我的回访计划", plannedAt: new Date(Date.now() + 86_400_000) } });
    await p.opportunity.create({ data: { customerId: id.老板的, ownerId: 老板id, name: "老板的大单", amount: 990_000 } });
    await p.opportunity.create({ data: { customerId: id.我的, ownerId: 我id, name: "我的小单", amount: 1_200 } });
    await p.contract.create({ data: { customerId: id.老板的, amount: 770_000, signedAt: new Date() } });
  } finally {
    await p.$disconnect();
  }
  await 设云端团队(request, 团队);
  writeFileSync(
    path.join(DATA_DIR, ".team.json"),
    // 形状照 lib/sync/client.ts 的 团队配置；钥匙 43 位 base64url（这里不加解密，推拉都是空的）
    JSON.stringify({ teamId: 团队.id, teamName: 团队.name, joinSecret: "e2e", key: "A".repeat(43), device: "dev_e2e", pulled: 0 }),
    { mode: 0o600 },
  );
});

test.afterAll(async () => {
  rmSync(path.join(DATA_DIR, ".team.json"), { force: true });
  const p = 连库();
  try {
    await p.user.updateMany({ where: { id: { in: [我id, 老板id] } }, data: { active: false } });
  } finally {
    await p.$disconnect();
  }
});

test("进了团队：「我」是按云端账号改过身份的那一行；设置 → 团队按中转名单把我对成业务员", async ({ page }) => {
  await 进门(page, "/settings?tab=team");
  const 栏 = page.getByRole("tabpanel", { name: /^团队/ });
  await expect(栏.getByRole("heading", { name: 团队.name })).toBeVisible();
  await expect(栏).toContainText("你是业务员");
  await expect(栏.locator(".team-members li", { hasText: "王老板" })).toContainText("老板");
  await expect(栏.locator(".team-members li", { hasText: 云端账号.name })).toContainText("业务员");

  // 角色是本机自己对的（User.role 不同步）：对完库里就是 SALES
  const p = 连库();
  try {
    await expect.poll(async () => (await p.user.findUniqueOrThrow({ where: { id: 我id } })).role).toBe("SALES");
  } finally {
    await p.$disconnect();
  }
  // 自动登录签给的是「我」这一行，不是第一个管理员
  await expect(page.getByRole("button", { name: "林小雨（团队），账号菜单" })).toBeVisible();
});

test("业务员的客户列表：只有自己负责的、渠道是自己的、公海里的；老板的和原来管理员的都看不到", async ({ page }) => {
  // 限定有 3 秒缓存（team-scope.ts 的 限定的我），角色刚对过，等它过期
  await page.waitForTimeout(3500);
  await 进门(page, "/customers");
  const 表 = page.locator("main");
  await expect(表.getByRole("link", { name: 名.我的 })).toBeVisible();
  await expect(表.getByRole("link", { name: 名.渠道是我 })).toBeVisible();
  await expect(表.getByRole("link", { name: 名.公海 })).toBeVisible();
  await expect(表.getByRole("link", { name: 名.老板的 })).toHaveCount(0);
  // 前面几组以原来那位管理员身份建的客户（不自动跑、提醒客户……）也不是我的
  await expect(表.getByRole("link", { name: "不自动跑" })).toHaveCount(0);
  await expect(表.getByRole("link", { name: "提醒客户" })).toHaveCount(0);
  await expect(page.locator("tr.ant-table-row")).toHaveCount(3);

  // 跟进记录页同一个口径：老板那位客户上的跟进不出现
  await page.goto("/follow-ups");
  await page.waitForLoadState("networkidle").catch(() => {});
  await expect(page.locator("main")).not.toContainText("老板亲自谈的价");
});

test("业务员按网址直接打开老板的客户：找不到；自己的、公海的照常打开", async ({ page }) => {
  await 进门(page);
  // 限定之下这一位「不存在」：记录页走 notFound()。布局已经开始流式输出，状态码还是 200，看的是页面上那句话
  await page.goto(`/customers/${id.老板的}`);
  await expect(page.locator("main")).toContainText("这条记录不在了");
  await expect(page.getByRole("heading", { name: 名.老板的 })).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("老板亲自谈的价");

  await page.goto(`/customers/${id.我的}`);
  await expect(page.getByRole("heading", { name: 名.我的 })).toBeVisible();
  await page.goto(`/customers/${id.公海}`);
  await expect(page.getByRole("heading", { name: 名.公海 })).toBeVisible();
});

/* ---------------- 上线前测试 4.2：其余几处入口也只有自己的 + 公海 ---------------- */

test("业务员搜索：搜老板客户的名字搜不到；联系人页、计划页、商机页也没有老板客户上的", async ({ page }) => {
  await 进门(page, `/customers?keyword=${encodeURIComponent("权限-老板")}`);
  await expect(page.locator("main")).not.toContainText(名.老板的);
  await expect(page.locator("tr.ant-table-row")).toHaveCount(0);
  await page.goto(`/customers?keyword=${encodeURIComponent("权限-")}`);
  await expect(page.locator("tr.ant-table-row")).toHaveCount(3);
  // 按号码搜也一样（号码搜不走名字那条路）
  await page.goto("/customers?keyword=13600000004");
  await expect(page.locator("tr.ant-table-row")).toHaveCount(0);

  await page.goto("/contacts");
  await expect(page.locator("main")).toContainText("我客户的联系人");
  await expect(page.locator("main")).not.toContainText("老板客户的联系人");

  await page.goto("/follow-ups/plans");
  await expect(page.locator("main")).toContainText("我的回访计划");
  await expect(page.locator("main")).not.toContainText("老板的回访计划");

  await page.goto("/opportunities");
  await expect(page.locator("main")).toContainText("我的小单");
  await expect(page.locator("main")).not.toContainText("老板的大单");
});

test("业务员导出客户：文件里只有自己的、渠道是自己的、公海的", async ({ page }) => {
  await 进门(page, "/customers");
  const [下载] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: /导\s*出/ }).click()]);
  const 内容 = readFileSync((await 下载.path())!, "utf8");
  for (const n of [名.我的, 名.渠道是我, 名.公海]) expect(内容, `导出里该有「${n}」`).toContain(n);
  expect(内容, "导出里不该有老板的客户").not.toContain(名.老板的);
  expect(内容).not.toContain("不自动跑");
  const 行 = 内容.replace(/^\ufeff/, "").split("\r\n").filter((l) => l.trim());
  expect(行, `表头 1 行 + 看得到的 3 位：\n${内容}`).toHaveLength(4);
});

test("业务员的数据页：新增客户只数看得到的 3 位，进行中商机不含老板的大单，本月签约不含老板签的", async ({ page }) => {
  await 进门(page, "/overview");
  const 卡 = (名字: string) => page.locator(".stat-card", { has: page.locator(".stat-label", { hasText: 名字 }) });
  await expect(卡("新增客户").locator(".stat-value")).toHaveText("3");
  await expect(卡("进行中商机").locator(".stat-value")).toHaveText("1");
  await expect(卡("进行中商机")).not.toContainText("99");
  await expect(卡("本月签约").locator(".stat-value")).not.toContainText("77");
  await expect(page.locator("main")).not.toContainText(名.老板的);
});

test("业务员新建客户：负责人默认是我，建完自己的列表里就有（T-015 / 4.4）", async ({ page }) => {
  await 进门(page, "/customers");
  await page.getByRole("button", { name: /新建客户/ }).click();
  const 框 = page.getByRole("dialog");
  await expect(框.getByLabel("销售负责人").locator("xpath=ancestor::div[contains(@class,'ant-select')][1]")).toContainText("林小雨（团队）");
  await 框.getByLabel("客户姓名").fill("权限-我刚建的");
  await 框.getByLabel("联系电话").fill("13600000005");
  await 框.getByRole("button", { name: /保\s*存/ }).click();
  await expect(框).toBeHidden();
  const p = 连库();
  try {
    expect((await p.customer.findFirstOrThrow({ where: { name: "权限-我刚建的" } })).salesOwnerId).toBe(我id);
  } finally {
    await p.$disconnect();
  }
  await page.goto(`/customers?keyword=${encodeURIComponent("权限-我刚建的")}`);
  await expect(page.locator("tr.ant-table-row")).toHaveCount(1);
});

test("被老板移出（中转名单里没这个团了）：设置 → 团队只摆「退出团队」，不摆作废的邀请码（T-050）", async ({ page, request }) => {
  // 中转的名单里没有这个团（被移出 / 在别的电脑上退了）；推拉照旧回空（假云端不回「不在这个团队」，免得触发自动退出删数据）
  expect((await request.delete(`${CLOUD_URL}/__stub/team`)).ok()).toBe(true);
  try {
    await 进门(page, "/settings?tab=team");
    const 栏 = page.getByRole("tabpanel", { name: /^团队/ });
    await expect(栏).toContainText("已不在团队里");
    await expect(栏).toContainText(`你已经不在「${团队.name}」里了`);
    await expect(栏.getByRole("button", { name: "退出团队" })).toBeVisible();
    // 作废的邀请码不摆（那句说明里「找老板要一个新的邀请码」不算）：没有码、没有复制 / 换码按钮，只有「退出团队」这一个动作
    await expect(栏).not.toContainText("DT2.");
    await expect(栏).not.toContainText("连不上云端");
    await expect(栏.getByRole("button")).toHaveCount(1);
    await expect(栏.getByRole("textbox")).toHaveCount(0);
  } finally {
    await 设云端团队(request, 团队);
  }
});
