/**
 * 全局 AI 面板（AiDock，⌘J）。
 *
 * 这一组不调模型——默认 e2e 的 LLM_API_KEY 是空的。钉的是**壳的行为**，
 * 那才是这一版真正改动的东西：
 *   1. 它在该在的页面上在，不该在的地方不在（首页就是宽模式的同一块，两处同时画会打架）
 *   2. 导航稳定：开合面板时左栏一格不动——这是拍过板的规矩
 *   3. 上下文看得见、点得掉；换一页重新带上
 *   4. 收起时入口在左栏底部（「问一句 ⌘J」）：第一版的浮钮压住列表页右上角的主动作，
 *      第二版右边 44px 的窄边又把笔记本上每张表挤掉最右一列
 *   5. 放得下才常驻：窗口不到 1600 宽默认收着（13、14 寸笔记本上看板和表格才摆得开）
 */
import { test, expect, type Page } from "@playwright/test";
import { 装个假模型, 拆掉假模型, 假回答 } from "./fake-llm";
import { 连库 } from "./mock-data";

const 账号 = { 用户名: "zhangsan", 密码: "admin123" };

/**
 * 面板只在配了 AI 时才渲染——没配就不该有这个入口，而不是点开一个说"先去配 AI"的空壳。
 * 默认 e2e 故意把 LLM_API_KEY 设成空（见 playwright.config.ts：记录页的 AI 面板打开即生成，
 * 有 key 的话每条用例都会真调一次模型）。所以这一组自己往库里写一条配置，
 * 装的那个模型指向一个死端口（见 fake-llm.ts，它走的是人真正会走的那条设置路）。
 * 跑完拆掉，不留给后面的用例。
 */
test.beforeAll(async ({ browser }) => 装个假模型(browser));
test.afterAll(async ({ browser }) => 拆掉假模型(browser));

async function 登录(page: Page) {
  await page.goto("/login");
  const 提示 = page.locator(".ant-alert");
  for (let i = 0; i < 3; i++) {
    await page.getByPlaceholder("用户名").fill(账号.用户名);
    await page.getByPlaceholder("登录密码").fill(账号.密码);
    await page.getByRole("button", { name: /登\s*录/ }).click();
    for (let t = 0; t < 40; t++) {
      if (/\/dashboard/.test(page.url())) return;
      if (await 提示.isVisible().catch(() => false)) throw new Error("登录失败");
      await page.waitForTimeout(200);
    }
  }
  throw new Error("登录超时");
}

const 面板 = (p: Page) => p.locator("aside.dock");
/** 面板收着时的入口，在左栏底部 */
const 开键 = (p: Page) => p.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: /打开 AI 面板/ });

test.describe("全局 AI 面板", () => {
  // 常驻要窗口够宽（≥1600，见 AppShell 的 面板放不下）；窄窗口的行为在最后那组单独测
  test.use({ viewport: { width: 1680, height: 1000 } });

  test("首页不出现——那儿本来就是宽模式的同一块东西", async ({ page }) => {
    await 登录(page);
    await expect(开键(page)).toHaveCount(0);
    await expect(面板(page)).toHaveCount(0);
  });

  test("窗口够宽时其余页面**默认就开着**，宽 380——不用点、也不用 ⌘J", async ({ page }) => {
    /** 用户定的：「保持常驻吧，不要点击或者 command J 才能开启」 */
    await 登录(page);
    await page.goto("/customers");
    await expect(面板(page)).toBeVisible();
    expect(Math.round((await 面板(page).boundingBox())!.width)).toBe(380);
    await expect(开键(page)).toHaveCount(0);
  });

  test("关掉之后记住：换一页还是关着，直到自己再打开", async ({ page }) => {
    await 登录(page);
    await page.goto("/customers");
    await page.getByRole("button", { name: "关闭 AI 面板" }).click();
    await expect(开键(page)).toBeVisible();
    await page.goto("/channels");
    await expect(面板(page)).toHaveCount(0);
    await expect(开键(page)).toBeVisible();
    await 开键(page).click();
    await expect(面板(page)).toBeVisible();
  });

  test("面板和对话列表都能拖宽，宽度记得住", async ({ page }) => {
    /** 和左栏同一条缝（WidthHandle）。名字和句子多长不是我们定的，最后一寸交给用它的人 */
    await 登录(page);
    await page.goto("/channels");
    const 缝 = page.getByRole("separator", { name: /调整 AI 面板宽度/ });
    const 原 = (await 面板(page).boundingBox())!.width;
    const 框 = (await 缝.boundingBox())!;
    await page.mouse.move(框.x + 框.width / 2, 框.y + 200);
    await page.mouse.down();
    await page.mouse.move(框.x - 60, 框.y + 200, { steps: 8 });
    await page.mouse.up();
    const 新 = (await 面板(page).boundingBox())!.width;
    expect(新).toBeGreaterThan(原 + 40); // 往左拖是变宽

    // 换一页还记得
    await page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "客户" }).click();
    await expect(page).toHaveURL(/\/customers/);
    expect(Math.abs((await 面板(page).boundingBox())!.width - 新)).toBeLessThan(2);

    // 双击回默认
    await 缝.dblclick();
    expect(Math.round((await 面板(page).boundingBox())!.width)).toBe(380);
  });

  test("首页的对话列表也能拖", async ({ page }) => {
    await 登录(page);
    const 列 = page.locator(".pane-chat");
    await expect(列).toBeVisible();
    const 原 = (await 列.boundingBox())!.width;
    const 缝 = page.getByRole("separator", { name: /调整对话列表宽度/ });
    const 框 = (await 缝.boundingBox())!;
    await page.mouse.move(框.x + 框.width / 2, 框.y + 200);
    await page.mouse.down();
    await page.mouse.move(框.x + 70, 框.y + 200, { steps: 8 });
    await page.mouse.up();
    expect((await 列.boundingBox())!.width).toBeGreaterThan(原 + 40);
    await 缝.dblclick();
    expect(Math.round((await 列.boundingBox())!.width)).toBe(232);
  });

  test("⌘J 关了再开；关掉之后左栏有入口", async ({ page }) => {
    await 登录(page);
    await page.goto("/channels");
    await expect(面板(page)).toBeVisible(); // 默认开着
    await page.keyboard.press("ControlOrMeta+j");
    await expect(面板(page)).toHaveCount(0);
    await expect(开键(page)).toBeVisible();
    await page.keyboard.press("ControlOrMeta+j");
    await expect(面板(page)).toBeVisible();
  });

  /**
   * **Esc 不关面板。**
   *
   * 它是常驻的一栏，不是弹层。而且 Esc 在面板里已经有主人：答案正在流的时候
   * 它是「打断」（输入框下面就写着「Esc 打断」）。两个处理器听同一个键的话，
   * 想停下一个跑偏的回答会连面板一起收掉——2026-09-19 用户报上来的。
   */
  test("Esc 不收面板：它是一栏，不是弹层", async ({ page }) => {
    await 登录(page);
    await page.goto("/channels");
    await expect(面板(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(面板(page)).toBeVisible();
    // 输入框里按也一样——那儿的 Esc 是留给「打断」的
    await page.locator("aside.dock textarea").first().click();
    await page.keyboard.press("Escape");
    await expect(面板(page)).toBeVisible();
  });

  test("导航稳定：开合面板时左栏一格不动", async ({ page }) => {
    await 登录(page);
    await page.goto("/customers");
    const 左栏 = page.locator("nav.rail");
    const 前 = (await 左栏.boundingBox())!;
    await page.keyboard.press("ControlOrMeta+j"); // 关
    await expect(面板(page)).toHaveCount(0);
    const 后 = (await 左栏.boundingBox())!;
    expect(后.x).toBe(前.x);
    expect(后.width).toBe(前.width);
  });

  test("收起时正文一直铺到窗口右边，入口在左栏不占正文", async ({ page }) => {
    /**
     * 第一版的浮钮压在「新建」上；第二版右边 44px 的窄边不压东西了，可 1120 宽时
     * 客户表的负责人、跟进表的时间都被它挤出去（2026-09-28 核对教程时看到）。
     */
    await 登录(page);
    await page.goto("/customers");
    await page.keyboard.press("ControlOrMeta+j"); // 收起来
    await expect(面板(page)).toHaveCount(0);
    await expect(开键(page)).toBeVisible();
    const 正文 = (await page.locator("main").boundingBox())!;
    expect(正文.x + 正文.width).toBeGreaterThanOrEqual(1680 - 1);
  });

  test("上下文：写出来、点得掉、换一页重新带上", async ({ page }) => {
    await 登录(page);
    await page.goto("/customers?followStatus=" + encodeURIComponent("已签约"));
    const 条 = page.locator(".dock-ctx");
    await expect(条).toBeVisible();
    await expect(条).toContainText("客户");
    await expect(条).toContainText("已签约");

    // 点掉
    await page.getByRole("button", { name: "不带这一页的上下文" }).click();
    await expect(条).toHaveCount(0);

    /*
      换一页：那是新的一页，不是他刚才拒绝的那个，上下文要重新带上。
      **走左栏点过去（客户端导航），不是 page.goto**——goto 是整页重载，
      面板状态本来就会重置，那样测的是重载不是换页。顺便钉住「切页不断流」：
      面板挂在壳上，换页时它不该被卸掉重来。
    */
    await page.getByRole("navigation", { name: "主导航" }).getByRole("link", { name: "渠道" }).click();
    await expect(page).toHaveURL(/\/channels/);
    await expect(面板(page)).toBeVisible();
    await expect(page.locator(".dock-ctx")).toContainText("渠道");
  });

  test("记录页：面板知道看的是谁", async ({ page }) => {
    // 路径里只有 id，名字要记录页自己登记（lib/page-rows.ts）。以前没人登记，这一页的上下文一直是空的
    const p = 连库();
    const 销售 = await p.user.findFirstOrThrow({ where: { role: { not: "ADMIN" } } });
    const c = await p.customer.create({ data: { name: "面板认人", phone: "13900009999", salesOwnerId: 销售.id } });
    try {
      await 登录(page);
      await page.goto(`/customers/${c.id}`);
      await expect(page.locator(".dock-ctx")).toContainText("客户 · 面板认人");
    } finally {
      await p.customer.delete({ where: { id: c.id } });
      await p.$disconnect();
    }
  });

  /*
    2026-10-04（回归核对 J-135）：「AI 不自动跑」是拍过板的（开户只送 30 次、不再补），
    记录页原来打开就生成一份简报、白花一次。修了但没钉：配好 AI、打开记录页停几秒，生成接口一次都不许被叫
  */
  test("打开客户记录页、打开 AI 抽屉都不自动跑：/api/ai/stream 一次都没被叫，点了才叫", async ({ page }) => {
    const p = 连库();
    const 销售 = await p.user.findFirstOrThrow({ where: { role: { not: "ADMIN" } } });
    const c = await p.customer.create({ data: { name: "不自动跑", phone: "13900008888", salesOwnerId: 销售.id } });
    // 有跟进记录才有简报区（没有记录时那一块根本不画，就测不出它跑没跑）
    await p.followUp.create({ data: { customerId: c.id, ownerId: 销售.id, type: "CALL", title: "电话", content: "聊了预算", status: "已完成", occurredAt: new Date() } });
    const 叫了: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/api/ai/stream")) 叫了.push(r.url());
    });
    try {
      await 登录(page);
      await page.goto(`/customers/${c.id}`);
      await expect(page.locator(".dock-ctx")).toContainText("不自动跑");
      await page.waitForTimeout(4000);
      expect(叫了).toEqual([]);
      // 窄一点的窗口简报区收在页头「AI」按钮打开的抽屉里：打开抽屉也不许自己跑
      const 抽屉键 = page.getByRole("button", { name: /^thunderbolt AI$/ });
      if (await 抽屉键.isVisible()) await 抽屉键.click();
      await expect(page.getByRole("button", { name: /生成简报/ })).toBeVisible();
      await page.waitForTimeout(3000);
      expect(叫了).toEqual([]);
      // 反过来证明这只耳朵是好的：人点了才叫
      await page.getByRole("button", { name: /生成简报/ }).click();
      await expect.poll(() => 叫了.length).toBeGreaterThan(0);
    } finally {
      await p.followUp.deleteMany({ where: { customerId: c.id } });
      await p.customer.delete({ where: { id: c.id } });
      await p.$disconnect();
    }
  });

  test("面板开着时正文跟着收窄，不出横向滚动条", async ({ page }) => {
    await 登录(page);
    await page.goto("/channels");
    await expect(面板(page)).toBeVisible();
    const 溢出 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(溢出).toBeLessThanOrEqual(1);
    // antd 的 xl 断点看视口不看这一栏，所以壳要标出「面板开着」让样式表重映射
    await expect(page.locator(".shell.shell-dock-open")).toHaveCount(1);
  });
});

/*
  2026-10-04 回归核对 J-162 / J-164 / J-165 / J-171 / J-175 / J-187：面板和建议卡的样子都修过、都没钉。
  回答是拦下 /api/ai/stream 喂的（见 fake-llm.ts 的 假回答），建议卡的确认 / 撤销走真的服务端
*/
test.describe("面板里的回答和建议卡", () => {
  test.use({ viewport: { width: 1680, height: 1000 } });

  async function 在面板里问(page: Page, 问题: string) {
    const 框 = page.locator("aside.dock textarea").first();
    await 框.fill(问题);
    await 框.press("Enter");
  }

  test("J-187：面板里的对话区不撑出面板（.cli 的 100vh 最小高度在面板里归零）", async ({ page }) => {
    await 登录(page);
    await page.goto("/channels");
    await expect(面板(page)).toBeVisible();
    // 修法就是这一条：面板里 .cli 的最小高度归零，不再按整窗 100vh 算
    expect(await page.locator("aside.dock .cli").first().evaluate((el) => getComputedStyle(el).minHeight)).toBe("0px");
    const 板 = (await 面板(page).boundingBox())!;
    const 区 = (await page.locator("aside.dock .cli").first().boundingBox())!;
    expect(区.y + 区.height, "对话区底边不许超出面板底边").toBeLessThanOrEqual(板.y + 板.height + 1);
    // 输入框也在面板里看得见，不被顶到窗外
    const 框 = (await page.locator("aside.dock textarea").first().boundingBox())!;
    expect(框.y + 框.height).toBeLessThanOrEqual(1000);
  });

  test("J-165：面板开着时在列表页按 ⌘K，弹的是跳转单——不是把光标塞进面板输入框", async ({ page }) => {
    await 登录(page);
    await page.goto("/channels");
    await expect(面板(page)).toBeVisible();
    await page.locator("main").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("ControlOrMeta+k");
    await expect(page.locator(".cmdk")).toBeVisible();
    await expect(page.locator("aside.dock textarea").first()).not.toBeFocused();
  });

  test("J-162：面板里答一段很长的话，左边正文一像素都不跟着滚", async ({ page }) => {
    const 长 = Array.from({ length: 60 }, (_, i) => `第 ${i + 1} 条：这是一段很长的回答，用来把面板撑到要滚动。`).join("\n\n");
    await 假回答(page, { text: 长 });
    // 正文得自己能滚，才看得出被带着滚了没有：备一页满的客户
    const p = 连库();
    const 销售 = await p.user.findFirstOrThrow({ where: { email: 账号.用户名 } });
    await p.customer.createMany({ data: Array.from({ length: 30 }, (_, i) => ({ name: `长回答垫底${i}`, phone: `1390001${String(1000 + i)}`, salesOwnerId: 销售.id })) });
    try {
      await 登录(page);
      await page.goto("/customers");
      await expect(面板(page)).toBeVisible();
      expect(await page.evaluate(() => document.scrollingElement!.scrollHeight > document.scrollingElement!.clientHeight), "正文得比窗口长").toBe(true);
      const 滚了多少 = () =>
        page.evaluate(() => ({
          文档: document.scrollingElement?.scrollTop ?? 0,
          正文: document.querySelector("main")?.scrollTop ?? 0,
          // 面板外面每一个能滚的祖先
          外层: [...document.querySelectorAll<HTMLElement>("body *")]
            .filter((el) => !el.closest("aside.dock") && el.scrollTop > 0)
            .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)}=${el.scrollTop}`),
        }));
      const 前 = await 滚了多少();
      await 在面板里问(page, "说一段长的");
      await expect(page.locator("aside.dock")).toContainText("第 60 条");
      await page.waitForTimeout(800); // 平滑滚动走完
      const 后 = await 滚了多少();
      expect(后.文档).toBe(前.文档);
      expect(后.正文).toBe(前.正文);
      expect(后.外层, "面板外面有东西被滚了").toEqual(前.外层);
      // 面板自己是滚了的——不然就是没撑长，这条测了个寂寞
      expect(await page.locator("aside.dock .dock-body").evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    } finally {
      await p.customer.deleteMany({ where: { name: { startsWith: "长回答垫底" } } });
      await p.$disconnect();
    }
  });

  test("J-164 / J-175：380 宽面板里记跟进卡的「确认」一行摆得下；确认后写着几点写入、能撤销，撤了跟进就没了", async ({ page }) => {
    const p = 连库();
    const 销售 = await p.user.findFirstOrThrow({ where: { email: 账号.用户名 } });
    const c = await p.customer.create({ data: { name: "卡片撤销", phone: "13900007777", salesOwnerId: 销售.id } });
    try {
      await 假回答(page, {
        text: "已经给出建议，你确认一下。",
        proposals: [{ id: "p-fu", kind: "add_followup", customerId: c.id, customerName: c.name, reason: "你刚说打过电话", type: "PHONE", title: "电话", content: "聊了预算，下周再约", occurredAt: new Date().toISOString() }],
      });
      await 登录(page);
      await page.goto("/channels");
      await expect(面板(page)).toBeVisible();
      await 在面板里问(page, "给卡片撤销记一笔电话");
      const 卡 = page.locator("aside.dock .prop").first();
      await expect(卡).toBeVisible();
      const 键 = 卡.locator(".prop-ok");
      await expect(键).toBeEnabled();
      // 挤成两行竖排时高度翻倍；一行的按钮不会比一行字加内边距高多少
      const 高 = (await 键.boundingBox())!.height;
      const 行高 = await 键.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight) || 20);
      expect(高, `确认按钮高 ${高}，一行字 ${行高}`).toBeLessThan(行高 * 2);
      expect(await 键.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), "按钮里的字被挤出去了").toBe(true);

      await 键.click();
      const 回执 = page.locator("aside.dock .prop-done").first();
      await expect(回执).toContainText(/已写入 \d{2}:\d{2}/);
      await expect.poll(() => p.followUp.count({ where: { customerId: c.id } })).toBe(1);

      await 回执.getByRole("button", { name: "撤销" }).click();
      await expect(page.locator(".ant-message")).toContainText("已撤销");
      await expect.poll(() => p.followUp.count({ where: { customerId: c.id } })).toBe(0);
      // 撤销完卡片回到「等你确认」，还能再确认或忽略
      await expect(page.locator("aside.dock .prop .prop-ok").first()).toBeVisible();
    } finally {
      await p.followUp.deleteMany({ where: { customerId: c.id } });
      await p.customer.delete({ where: { id: c.id } });
      await p.$disconnect();
    }
  });

  test("J-171：改渠道卡上看得见电话那一格和它现在的号，备注一格写明「填了会整段换掉」", async ({ page }) => {
    await 假回答(page, {
      text: "已经给出建议，你确认一下。",
      proposals: [{
        id: "p-ch", kind: "update_channel", customerId: "", customerName: "", reason: "你说他换号了",
        channelName: "卡片渠道", ownerName: "", phone: "13911112222", remark: "",
        现值: { phone: "13800001111", remark: "原来的备注" },
      }],
    });
    await 登录(page);
    await page.goto("/channels");
    await expect(面板(page)).toBeVisible();
    await 在面板里问(page, "卡片渠道换号了");
    const 卡 = page.locator("aside.dock .prop").first();
    await expect(卡).toBeVisible();
    const 电话 = 卡.locator(".prop-f").filter({ has: page.locator(".prop-f-l", { hasText: /^电话$/ }) });
    await expect(电话).toBeVisible();
    await expect(电话.locator(".prop-f-was")).toContainText("13800001111");
    await expect(电话.locator("input")).toHaveValue("13911112222");
    const 备注 = 卡.locator(".prop-f").filter({ has: page.locator(".prop-f-l", { hasText: /^备注$/ }) });
    await expect(备注.locator(".prop-f-was")).toContainText("原来的备注");
    await expect(备注.locator("textarea")).toHaveAttribute("placeholder", /整段换掉/);
  });
});

test.describe("窗口不到 1600 宽", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("默认收着，正文占满；左栏入口和 ⌘J 都打得开", async ({ page }) => {
    /** 1440 是桌面端的默认窗口。常驻时正文只剩 840，商机看板只露两列半（2026-09-28 核对教程时看到） */
    await 登录(page);
    await page.goto("/customers");
    await expect(面板(page)).toHaveCount(0);
    await expect(page.locator(".shell.shell-dock-open")).toHaveCount(0);
    await 开键(page).click();
    await expect(面板(page)).toBeVisible();
    await page.keyboard.press("ControlOrMeta+j");
    await expect(面板(page)).toHaveCount(0);
  });
});
