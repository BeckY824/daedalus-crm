/**
 * 记录页、计划页上的几件小事（2026-10-04 回归核对 J1 / 上线前第 1 期）。
 *
 * 每一条都是出过的问题，代码早修了、一直没有用例：
 *   J-003 行内「职位」用键盘 ↓ 回车选候选，原来存成打了一半的字
 *   J-082 记录页勾完成的待办原地留着（划线 + 撤销），之后去「已完成」里看得到，不是人间蒸发
 *   J-097 记录页删待办先问一句（就地确认），点「取消」不删
 *   J-079 计划页每一行的「删」：先问、确认后那一行和库里都没了
 *   J-083 计划页点完成，那一行先留在原地（打勾的样子），不立刻抽走让下面的行跳上来
 *   签约金额自动带上勾选商机的金额之和，取消勾选跟着减，手填过就不再跟
 *
 * 删待办 / 删计划**没有撤销**（就地确认那一类，见 components/InlineConfirm.tsx 的取舍），
 * 规划里写的「删待办、删计划的撤销」写成【下一版】skip 放在这里，等拍板。
 */
import { test, expect, type Page } from "@playwright/test";
import { 连库, 清空业务数据 } from "./mock-data";

const 账号 = { 用户名: "zhangsan", 密码: "admin123" };

async function 登录(page: Page) {
  await page.goto("/login");
  await page.getByPlaceholder("用户名").fill(账号.用户名);
  await page.getByPlaceholder("登录密码").fill(账号.密码);
  await page.getByRole("button", { name: /登\s*录/ }).click();
  await page.waitForURL(/\/dashboard/);
}

test.describe.configure({ mode: "serial", timeout: 90_000 });

let 我id = "";
let 序 = 0;
/** 每条用例自己造一位客户，互不牵连 */
async function 造客户(名: string) {
  const p = 连库();
  try {
    序++;
    const c = await p.customer.create({ data: { name: 名, phone: `1386666${String(Date.now() % 1000).padStart(3, "0")}${序}`.slice(0, 11), salesOwnerId: 我id } });
    return c.id;
  } finally {
    await p.$disconnect();
  }
}

async function 查<T>(做: (p: ReturnType<typeof 连库>) => Promise<T>): Promise<T> {
  const p = 连库();
  try {
    return await 做(p);
  } finally {
    await p.$disconnect();
  }
}

/** dev server 下页面刚出来可能还没水合完，第一下点了没反应——没出来就再点，别把它当成用例失败 */
async function 点到出现(点: ReturnType<Page["locator"]>, 出现: ReturnType<Page["locator"]>) {
  await expect(async () => {
    if (!(await 出现.isVisible())) await 点.click();
    await expect(出现).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}

test.beforeAll(async () => {
  const p = 连库();
  await 清空业务数据(p);
  我id = (await p.user.findFirstOrThrow({ where: { email: 账号.用户名 } })).id;
  await p.$disconnect();
});

test.afterAll(async () => {
  const p = 连库();
  await 清空业务数据(p);
  await p.$disconnect();
});

test("J-003 行内「职位」：敲两个字 → ↓ 回车选候选 → 存的是候选全文，不是打了一半的字", async ({ page }) => {
  const id = await 造客户("键盘选职位");
  await 登录(page);
  await page.goto(`/customers/${id}`);
  // 点开那一格（dev 下刚出来可能还没水合：没变成输入框就再点）
  const 格 = page.getByRole("button", { name: "编辑职位" });
  const 框 = page.locator(".rec-field-editing input");
  await expect(async () => {
    if (!(await 框.isVisible())) await 格.click();
    await expect(框).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
  await 框.pressSequentially("部门");
  await expect(page.locator(".ant-select-dropdown:visible .ant-select-item-option", { hasText: "部门负责人" })).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect.poll(() => 查((p) => p.customer.findUniqueOrThrow({ where: { id } }).then((c) => c.grade))).toBe("部门负责人");
  await page.reload();
  await expect(page.getByRole("button", { name: "编辑职位" })).toContainText("部门负责人");
});

test("J-082 记录页勾完成的待办：原地划线留着、能撤销；之后在「已完成」里看得到", async ({ page }) => {
  const id = await 造客户("勾待办");
  const 待办 = await 查((p) => p.task.create({ data: { title: "寄样品", customerId: id, ownerId: 我id, dueAt: new Date(Date.now() + 86400_000) } }));
  await 登录(page);
  await page.goto(`/customers/${id}`);
  const 行 = page.locator(".rec-task", { hasText: "寄样品" });
  // CI 机器慢：页面还没接上事件就点了，勾不上（10-07 main CI）——勾上为止
  await expect(async () => {
    await 行.getByRole("checkbox", { name: "完成 寄样品" }).check({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  // 勾完不立刻消失：原地划线，提示里给撤销
  await expect(行).toHaveClass(/is-done/);
  await expect.poll(() => 查((p) => p.task.findUniqueOrThrow({ where: { id: 待办.id } }).then((t) => t.done))).toBe(true);
  const 提示 = page.locator(".ant-message").getByText("「寄样品」已完成");
  await expect(提示).toBeVisible();
  await page.locator(".ant-message").getByRole("button", { name: /撤\s*销/ }).click();
  await expect.poll(() => 查((p) => p.task.findUniqueOrThrow({ where: { id: 待办.id } }).then((t) => t.done))).toBe(false);
  await expect(行).not.toHaveClass(/is-done/);

  // 再勾一次、等它收起：去计划页「已完成」那一屏看得到它
  await 行.getByRole("checkbox", { name: "完成 寄样品" }).check();
  await expect(行).toBeHidden({ timeout: 10_000 });
  await page.goto("/follow-ups/plans");
  await page.locator(".ant-segmented").first().getByText(/^已完成/).click();
  await expect(page.locator(".plan-row-was", { hasText: "寄样品" })).toBeVisible();
});

test("J-097 记录页删待办：先问一句；点「取消」不删，点「删除」才删", async ({ page }) => {
  const id = await 造客户("删待办");
  const 待办 = await 查((p) => p.task.create({ data: { title: "回个电话", customerId: id, ownerId: 我id } }));
  await 登录(page);
  await page.goto(`/customers/${id}`);
  const 行 = page.locator(".rec-task", { hasText: "回个电话" });
  await 点到出现(行.getByRole("button", { name: "删除待办" }), 行.getByText("删除这条？"));
  // 一点就删是原来的毛病：问的时候库里还在
  expect(await 查((p) => p.task.count({ where: { id: 待办.id } }))).toBe(1);
  await 行.getByRole("button", { name: "取消" }).click();
  await expect(行.getByText("删除这条？")).toBeHidden();
  expect(await 查((p) => p.task.count({ where: { id: 待办.id } }))).toBe(1);

  await 行.getByRole("button", { name: "删除待办" }).click();
  await 行.getByRole("button", { name: "删除", exact: true }).click();
  await expect(page.locator(".ant-message")).toContainText("待办已删除");
  await expect(page.locator(".rec-task", { hasText: "回个电话" })).toHaveCount(0);
  expect(await 查((p) => p.task.count({ where: { id: 待办.id } }))).toBe(0);
});

test.skip("【下一版】记录页删待办之后，提示条里能撤销、原样回来", async ({ page }) => {
  const id = await 造客户("删待办撤销");
  await 查((p) => p.task.create({ data: { title: "删了再要回来", customerId: id, ownerId: 我id } }));
  await 登录(page);
  await page.goto(`/customers/${id}`);
  const 行 = page.locator(".rec-task", { hasText: "删了再要回来" });
  await 点到出现(行.getByRole("button", { name: "删除待办" }), 行.getByText("删除这条？"));
  await 行.getByRole("button", { name: "删除", exact: true }).click();
  await page.locator(".ant-message").getByRole("button", { name: /撤\s*销/ }).click();
  await expect(page.locator(".rec-task", { hasText: "删了再要回来" })).toBeVisible();
});

test("J-079 计划页每一行的「删」：先问、确认后那一行和库里都没了", async ({ page }) => {
  const id = await 造客户("计划页删一条");
  const 计划 = await 查((p) => p.followPlan.create({ data: { customerId: id, ownerId: 我id, subject: "删掉的回访", method: "电话沟通", plannedAt: new Date(Date.now() + 2 * 3600_000) } }));
  await 登录(page);
  await page.goto("/follow-ups/plans");
  const 行 = page.locator(".plan-row", { hasText: "删掉的回访" });
  await 点到出现(行.getByRole("button", { name: "删除 删掉的回访" }), 行.getByText("删除这条？"));
  expect(await 查((p) => p.followPlan.count({ where: { id: 计划.id } }))).toBe(1);
  await 行.getByRole("button", { name: "删除", exact: true }).click();
  await expect(page.locator(".ant-message")).toContainText("计划已删除");
  await expect(page.locator(".plan-row", { hasText: "删掉的回访" })).toHaveCount(0);
  expect(await 查((p) => p.followPlan.count({ where: { id: 计划.id } }))).toBe(0);
});

test.skip("【下一版】计划页删一条计划之后，提示条里能撤销、原样回来", async ({ page }) => {
  const id = await 造客户("删计划撤销");
  await 查((p) => p.followPlan.create({ data: { customerId: id, ownerId: 我id, subject: "删了再要回来的计划", method: "电话沟通", plannedAt: new Date(Date.now() + 2 * 3600_000) } }));
  await 登录(page);
  await page.goto("/follow-ups/plans");
  const 行 = page.locator(".plan-row", { hasText: "删了再要回来的计划" });
  await 点到出现(行.getByRole("button", { name: "删除 删了再要回来的计划" }), 行.getByText("删除这条？"));
  await 行.getByRole("button", { name: "删除", exact: true }).click();
  await page.locator(".ant-message").getByRole("button", { name: /撤\s*销/ }).click();
  await expect(page.locator(".plan-row", { hasText: "删了再要回来的计划" })).toBeVisible();
});

test("J-083 计划页点完成：那一行先留在原地打着勾，不立刻抽走", async ({ page }) => {
  const id = await 造客户("完成留位");
  await 查(async (p) => {
    for (const [i, 主题] of ["先做的回访", "后面那条"].entries()) {
      await p.followPlan.create({ data: { customerId: id, ownerId: 我id, subject: 主题, method: "电话沟通", plannedAt: new Date(Date.now() + (i + 1) * 3600_000) } });
    }
  });
  await 登录(page);
  await page.goto("/follow-ups/plans");
  const 行 = page.locator(".plan-row", { hasText: "先做的回访" });
  await 行.getByRole("button", { name: "完成 先做的回访" }).click();
  // 点完的那一刻还在原处、是「做完了」的样子；下面那条没顶上来
  await expect(行).toHaveClass(/plan-row-done/, { timeout: 300 });
  await expect(page.locator(".plan-row").filter({ hasText: /先做的回访|后面那条/ }).first()).toContainText("先做的回访");
  // 留够了再走
  await expect(行).toBeHidden({ timeout: 10_000 });
});

test("签约金额：自动带上勾着的商机金额之和；取消勾一个跟着减；手填过就不再跟", async ({ page }) => {
  const id = await 造客户("两单一起签");
  await 查(async (p) => {
    await p.opportunity.create({ data: { name: "年框", customerId: id, ownerId: 我id, amount: 10000, stage: "方案报价", probability: 60 } });
    await p.opportunity.create({ data: { name: "加购", customerId: id, ownerId: 我id, amount: 5000.5, stage: "初步沟通", probability: 20 } });
  });
  await 登录(page);
  await page.goto(`/customers/${id}`);
  const 签 = page.getByRole("dialog", { name: "登记签约" });
  await 点到出现(page.getByRole("button", { name: /登记签约/ }).first(), 签);
  const 金额 = 签.getByRole("spinbutton", { name: "签约金额" });
  await expect(金额).toHaveValue("15,000.5");
  // 不用 Playwright 的勾选 / 取消勾选：负载高时 React 还没把状态写回 input，它点完立刻读、报「点了状态没变」
  //（截图上勾正在变过去）。点一下、再等它变过去
  const 加购 = 签.getByRole("checkbox", { name: /加购/ });
  const 切到 = async (勾上: boolean) => {
    await 加购.click();
    await expect(加购).toBeChecked({ checked: 勾上 });
  };
  await 切到(false);
  await expect(金额).toHaveValue("10,000");
  await 切到(true);
  await expect(金额).toHaveValue("15,000.5");

  // 人自己改过金额：再动勾选，金额不再被冲掉
  await 金额.fill("12000");
  await 切到(false);
  await expect(金额).toHaveValue("12,000");
  await 签.getByRole("button", { name: /保\s*存/ }).click();
  await expect(page.locator(".ant-message")).toContainText("签约已记录");
  const 签约 = await 查((p) => p.contract.findMany({ where: { customerId: id } }));
  expect(签约.map((c) => c.amount)).toEqual([12000]);
});

test("J-088 记录页左栏的商机写状态：赢单、丢单各挂一个标，进行中的不挂（和商机列表的标一样）", async ({ page }) => {
  const id = await 造客户("商机状态");
  await 查((p) =>
    p.opportunity.createMany({
      data: [
        { name: "在谈的那单", customerId: id, ownerId: 我id, amount: 1000, stage: "方案报价", status: "OPEN" },
        { name: "赢下的那单", customerId: id, ownerId: 我id, amount: 2000, stage: "赢单成交", status: "WON" },
        { name: "丢掉的那单", customerId: id, ownerId: 我id, amount: 3000, stage: "谈判审核", status: "LOST" },
      ],
    }),
  );
  await 登录(page);
  await page.goto(`/customers/${id}`);
  const 行 = (名: string) => page.locator(".rec-mini", { hasText: 名 });
  await expect(行("赢下的那单")).toContainText("已赢单");
  await expect(行("丢掉的那单")).toContainText("已丢单");
  await expect(行("在谈的那单")).not.toContainText(/已赢单|已丢单/);
});
