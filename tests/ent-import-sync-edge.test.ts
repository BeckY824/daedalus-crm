/**
 * 企业版导入 · 飞书 / 钉钉存库定时同步的边界情况：断网、限流、令牌过期、字段改名。
 *
 * 两层都测：
 *   适配器层：真适配器 + 假网（tests/helpers/ent-fake-net.ts），看重试几次、等多久、换没换令牌、报错说没说清
 *   同步层：同一套真适配器经 换适配器 接进 同步一次，看结果、话、「拉到」挪没挪、留没留批次、库里写没写
 * 裁判：出错时「拉到」不动、不留同步批次、库不变，下一次能接着来；能自己恢复的（限流、令牌过期、断一下）这次就同步成功。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

import feishuFixture from "./fixtures/ent-feishu.json";
import dingtalkFixture from "./fixtures/ent-dingtalk.json";
import { prisma } from "@/lib/prisma";
import { resetDb } from "./reset";
import { invalidateSettingsCache } from "@/lib/settings";
import { 写一批 } from "@/lib/enterprise-import/apply";
import { 换适配器 } from "@/lib/enterprise-import/adapter";
import { 钉钉适配器, type 钉钉配置 } from "@/lib/enterprise-import/dingtalk";
import { 飞书适配器, type 飞书配置 } from "@/lib/enterprise-import/feishu";
import { 进备注 } from "@/lib/enterprise-import/mapping";
import { 接口出错 } from "@/lib/enterprise-import/net";
import { 不见的列, 读同步设置, 同步一次, 拉全量试跑, 已认映射 } from "@/lib/enterprise-import/sync";
import type { 映射, 来源 } from "@/lib/enterprise-import/types";
import { 假网, 断网, 超时, type 录制, type 响应 } from "./helpers/ent-fake-net";

const 我 = { id: "tester-id", name: "测试员" };

// —— 飞书（和 ent-import-adapters.test.ts 同一份录制）——
const 飞书: 飞书配置 = {
  appId: "cli_fake",
  appSecret: "fake-secret",
  表们: [
    { 实体: "customer", appToken: "bascnFake", tableId: "tblCust" },
    { 实体: "contact", appToken: "bascnFake", tableId: "tblCont" },
    { 实体: "opportunity", appToken: "bascnFake", tableId: "tblOpp" },
    { 实体: "followup", appToken: "bascnFake", tableId: "tblFol" },
  ],
};
const 飞书录 = feishuFixture as unknown as 录制;
const 表路径 = (tbl: string) => `/open-apis/bitable/v1/apps/bascnFake/tables/${tbl}`;
const 令牌路由 = "POST /open-apis/auth/v3/tenant_access_token/internal";
const 客户字段 = `GET ${表路径("tblCust")}/fields`;
const 客户第一页 = `POST ${表路径("tblCust")}/records/search`;
const 客户第二页 = `POST ${表路径("tblCust")}/records/search?page_token=p2`;

// —— 钉钉 ——
const 钉钉: 钉钉配置 = { appKey: "ding-fake", appSecret: "fake-secret", 操作人UserId: "manager01", 商机表单code: "PROC-FAKE-OPP" };
const 钉钉录 = dingtalkFixture as unknown as 录制;
const 钉令牌 = "POST /v1.0/oauth2/accessToken";
const 个人客户字段 = "GET /v1.0/crm/personalCustomers/objectMeta?relationType=crm_customer_personal";
const 企业客户字段 = "GET /v1.0/crm/personalCustomers/objectMeta?relationType=crm_customer";
const 个人客户 = "GET /v1.0/crm/personalCustomers?relationType=crm_customer_personal";
const 个人客户第二页 = "GET /v1.0/crm/personalCustomers?relationType=crm_customer_personal&nextToken=nt2";
const 企业客户 = "GET /v1.0/crm/personalCustomers?relationType=crm_customer";
const 跟进第二页 = "POST /topapi/crm/objectdata/followrecord/query?cursor=c2";

const 断三次 = (code?: string): 响应[] => [断网(code), 断网(code), 断网(code)];

/** 录制里某几条路由的列名改掉（原系统把「电话」改成「联系电话」）：列描述和记录里的键一起改 */
function 改列名(录: 录制, 路由们: string[], 旧: string, 新: string): Record<string, 响应[]> {
  return Object.fromEntries(路由们.map((k) => [k, JSON.parse(JSON.stringify(录.路由[k]).replaceAll(`"${旧}"`, `"${新}"`)) as 响应[]]));
}

/** 青禾食品（recCust3，在第二页）在飞书里补了电话，改于往后挪（远在 起始钟 之后，since 怎么算都在它前面） */
const 青禾补电话: Record<string, 响应[]> = {
  [客户第二页]: [
    {
      body: {
        code: 0,
        msg: "success",
        data: {
          has_more: false,
          total: 3,
          items: [
            {
              record_id: "recCust3",
              created_time: 1790816400000,
              last_modified_time: 4102444800000,
              fields: { 客户名称: [{ text: "青禾食品有限公司", type: "text" }], 电话: "13800000003", 创建时间: 1790816400000 },
            },
          ],
        },
      },
    },
  ],
};

/* ───────────────────────── 适配器层 ───────────────────────── */

describe("飞书适配器 · 断网", () => {
  it("一直连不上：重试 2 次（等 1s、2s）后报错，说清是连不上飞书、为什么", async () => {
    const n = 假网(飞书录, { [令牌路由]: 断三次() });
    const 拉 = new 飞书适配器(飞书, n.网).拉全量();
    await expect(拉).rejects.toThrow(接口出错);
    await expect(拉).rejects.toThrow(/连不上飞书.*域名解析不了/);
    expect(n.调过(令牌路由)).toHaveLength(3);
    expect(n.等过).toEqual([1000, 2000]);
  });

  it("30 秒没响应（超时）也按连不上处理，话里说等了 30 秒", async () => {
    const n = 假网(飞书录, { [客户字段]: [超时, 超时, 超时] });
    await expect(new 飞书适配器(飞书, n.网).拉全量()).rejects.toThrow(/连不上飞书.*等了 30 秒没响应/);
    expect(n.调过(客户字段)).toHaveLength(3);
  });

  it("断一下又好了：等 1 秒重试，接着拉全，一条不少", async () => {
    const n = 假网(飞书录, { [客户第二页]: [断网("ECONNRESET")] });
    const 记录 = await new 飞书适配器(飞书, n.网).拉全量();
    expect(记录).toHaveLength(8);
    expect(n.等过).toEqual([1000]);
    expect(n.调过(客户第二页)).toHaveLength(2);
  });

  it("翻页翻到一半断了：报错，不把半截当全量交出去", async () => {
    const n = 假网(飞书录, { [客户第二页]: 断三次("ECONNRESET") });
    await expect(new 飞书适配器(飞书, n.网).拉全量()).rejects.toThrow(/连不上飞书.*连接被断开/);
    // 第二页之后的表一张都没去拉
    expect(n.调过(`GET ${表路径("tblCont")}/fields`)).toHaveLength(0);
  });
});

describe("飞书适配器 · 限流 / 令牌过期", () => {
  it("拿令牌就被限流（429、99991400）：退避后拿到，接着拉全", async () => {
    const n = 假网(飞书录, { [令牌路由]: [{ status: 429, body: {} }, { body: { code: 99991400, msg: "request trigger frequency limit" } }] });
    const 记录 = await new 飞书适配器(飞书, n.网).拉全量();
    expect(记录).toHaveLength(8);
    expect(n.等过).toEqual([1000, 2000]);
  });

  it("翻页翻到一半令牌按钟到期：先换令牌再拉第二页，不等接口说过期", async () => {
    const n = 假网(飞书录, { [客户第一页]: [{ ...飞书录.路由[客户第一页][0], 拨: 7_000_000 }] });
    const 记录 = await new 飞书适配器(飞书, n.网).拉全量();
    expect(记录).toHaveLength(8);
    expect(n.调过(令牌路由)).toHaveLength(2);
    expect(n.调过(客户第一页)[0].headers.Authorization).toBe("Bearer t-fake-1");
    expect(n.调过(客户第二页)[0].headers.Authorization).toBe("Bearer t-fake-2");
  });
});

describe("飞书适配器 · 现有列", () => {
  it("按列描述报每类的列，和这次拉到几条无关（增量一条没拉到也照报）", async () => {
    const a = new 飞书适配器(飞书, 假网(飞书录).网);
    expect(await a.拉变化(new Date(4102444800000))).toEqual([]);
    const 客户 = a.现有列()?.customer;
    for (const 列 of ["客户名称", "行业", "负责人", "电话", "地址", "创建时间"]) expect(客户).toContain(列);
    expect(Object.keys(a.现有列() ?? {}).sort()).toEqual(["contact", "customer", "followup", "opportunity"]);
  });

  it("每次拉都重新报：原系统改了列名，旧名不再出现", async () => {
    const a = new 飞书适配器(飞书, 假网(飞书录, {}, 改列名(飞书录, [客户字段, 客户第一页, 客户第二页], "电话", "联系电话")).网);
    await a.拉全量();
    expect(a.现有列()?.customer).toContain("联系电话");
    expect(a.现有列()?.customer).not.toContain("电话");
  });
});

describe("钉钉适配器 · 断网 / 限流 / 令牌过期", () => {
  it("一直连不上：重试 2 次（等 1s、2s）后报错，说清是连不上钉钉", async () => {
    const n = 假网(钉钉录, { [钉令牌]: 断三次("ECONNREFUSED") });
    const 拉 = new 钉钉适配器(钉钉, n.网, 0).拉全量();
    await expect(拉).rejects.toThrow(接口出错);
    await expect(拉).rejects.toThrow(/连不上钉钉.*对方拒绝连接/);
    expect(n.调过(钉令牌)).toHaveLength(3);
    expect(n.等过).toEqual([1000, 2000]);
  });

  it("超时也按连不上处理", async () => {
    const n = 假网(钉钉录, { [个人客户字段]: [超时, 超时, 超时] });
    await expect(new 钉钉适配器(钉钉, n.网, 0).拉全量()).rejects.toThrow(/连不上钉钉.*等了 30 秒没响应/);
  });

  it("断一下又好了：接着拉全，一条不少", async () => {
    const n = 假网(钉钉录, { [个人客户第二页]: [断网("ETIMEDOUT")] });
    const 记录 = await new 钉钉适配器(钉钉, n.网, 0).拉全量();
    expect(记录).toHaveLength(9);
    expect(n.等过).toEqual([1000]);
  });

  it("翻页翻到一半断了（新接口 nextToken、老接口 cursor）：都报错", async () => {
    await expect(new 钉钉适配器(钉钉, 假网(钉钉录, { [个人客户第二页]: 断三次() }).网, 0).拉全量()).rejects.toThrow(/连不上钉钉/);
    await expect(new 钉钉适配器(钉钉, 假网(钉钉录, { [跟进第二页]: 断三次("ECONNRESET") }).网, 0).拉全量()).rejects.toThrow(/连不上钉钉.*连接被断开/);
  });

  it("拿令牌就被限流：退避后拿到，接着拉全", async () => {
    const n = 假网(钉钉录, { [钉令牌]: [{ status: 429, body: { code: "Throttling.Api", message: "too many requests" } }] });
    const 记录 = await new 钉钉适配器(钉钉, n.网, 0).拉全量();
    expect(记录).toHaveLength(9);
    expect(n.等过).toEqual([1000]);
  });

  it("翻页翻到一半令牌按钟到期：先换令牌再拉第二页", async () => {
    const n = 假网(钉钉录, { [个人客户]: [{ ...钉钉录.路由[个人客户][0], 拨: 7_000_000 }] });
    const 记录 = await new 钉钉适配器(钉钉, n.网, 0).拉全量();
    expect(记录).toHaveLength(9);
    expect(n.调过(钉令牌)).toHaveLength(2);
    expect(n.调过(个人客户)[0].headers["x-acs-dingtalk-access-token"]).toBe("dt-fake-1");
    expect(n.调过(个人客户第二页)[0].headers["x-acs-dingtalk-access-token"]).toBe("dt-fake-2");
  });

  it("现有列：个人 + 企业客户两套字段合在一起，企业客户一条没有也照报", async () => {
    const a = new 钉钉适配器(钉钉, 假网(钉钉录, {}, { [企业客户]: [{ body: { hasMore: false, maxResults: 100, values: [] } }] }).网, 0);
    await a.拉全量();
    const 客户 = a.现有列()?.customer;
    for (const 列 of ["记录ID", "负责人", "客户名称", "电话", "行业", "地址"]) expect(客户).toContain(列);
  });
});

/* ───────────────────────── 不见的列 ───────────────────────── */

describe("不见的列", () => {
  const 映射 = (列: 映射["列"]): 映射 => ({ 列, 负责人: {}, 值: { 阶段: {}, 线索状态: {}, 跟进类型: {}, 跟进状态: {} }, 默认负责人Id: "", 说明: {} });

  it("只看落到字段的列：不用的、拼进备注的不算", () => {
    const m = 映射({ customer: { 客户名称: "name", 手机: "phone", 旧备注: 进备注, 不要: "" } });
    expect(不见的列(m, { customer: new Set(["客户名称"]) }, [])).toBe("「客户」表里『手机』列不见了");
    expect(不见的列(m, { customer: new Set(["客户名称", "手机"]) }, [])).toBeNull();
  });

  it("拉到的记录里有的列也算在；适配器报不了列、这次也没拉到的那类不查", () => {
    const m = 映射({ customer: { 客户名称: "name", 手机: "phone" }, contact: { 姓名: "name" } });
    const 记录 = [{ 实体: "customer" as const, 外部ID: "c1", 字段: { 客户名称: "甲", 手机: "1" } }];
    expect(不见的列(m, null, 记录)).toBeNull();
    expect(不见的列(m, { contact: new Set(["名字"]) }, 记录)).toBe("「联系人」表里『姓名』列不见了");
  });

  it("超过 5 列只列前 5 个，后面说一共几列；几类都缺用分号隔开", () => {
    const 六列 = Object.fromEntries(["a", "b", "c", "d", "e", "f"].map((h) => [h, "remark"]));
    const m = 映射({ customer: 六列, followup: { 内容: "content" } });
    expect(不见的列(m, { customer: new Set(), followup: new Set() }, [])).toBe("「客户」表里『a』、『b』、『c』、『d』、『e』 等 6 列不见了；「跟进记录」表里『内容』列不见了");
  });
});

/* ───────────────────────── 同步层 ───────────────────────── */

beforeEach(async () => {
  await resetDb();
  invalidateSettingsCache();
  await prisma.user.create({ data: { id: 我.id, email: "t@x", name: 我.name, title: "管理员", role: "ADMIN", password: "x" } });
  await prisma.user.create({ data: { email: "zw@x", name: "张伟", title: "销售", role: "SALES", password: "x" } });
  await prisma.user.create({ data: { email: "ln@x", name: "李娜", title: "销售", role: "SALES", password: "x" } });
});

afterEach(() => {
  换适配器("feishu", null);
  换适配器("dingtalk", null);
});

afterAll(async () => {
  await prisma.$disconnect();
});

const 飞书接 = (先给: Record<string, 响应[]> = {}, 改: Record<string, 响应[]> = {}) => {
  const n = 假网(飞书录, 先给, 改);
  换适配器("feishu", new 飞书适配器(飞书, n.网));
  return n;
};
const 钉钉接 = (先给: Record<string, 响应[]> = {}, 改: Record<string, 响应[]> = {}) => {
  const n = 假网(钉钉录, 先给, 改);
  换适配器("dingtalk", new 钉钉适配器(钉钉, n.网, 0));
  return n;
};

/** 首次导入：拉全量试跑 + 正式导入（映射就此认下） */
async function 首次导入(源: 来源) {
  const { 批次Id } = await 拉全量试跑(源, 我.id);
  const r = await 写一批(批次Id, 我);
  expect(r.完了).toBe(true);
}
const 同步批数 = () => prisma.entImportBatch.count({ where: { kind: "sync" } });
const 库 = async () => ({
  客户: (await prisma.customer.findMany({ orderBy: { id: "asc" } })).map(({ updatedAt: _, ...r }) => r),
  联系人: await prisma.contact.count(),
  商机: await prisma.opportunity.count(),
  跟进: await prisma.followUp.count(),
});

/** 出错的同步：说了原因、「拉到」没挪、没留批次、库一格不变 */
async function 出错没动(源: 来源, 话: RegExp | string) {
  const 前 = await 库();
  const r = await 同步一次(源, { 用户: 我 });
  expect(r.结果).toBe("出错");
  if (typeof 话 === "string") expect(r.话).toContain(话);
  else expect(r.话).toMatch(话);
  expect((await 读同步设置(源)).拉到).toBeNull();
  expect(await 同步批数()).toBe(0);
  expect(await 库()).toEqual(前);
  return r;
}

describe("同步 · 断网", () => {
  it("飞书一直连不上：出错，说连不上飞书，不挪起点、不留批次；网好了下一次照常同步", async () => {
    飞书接();
    await 首次导入("feishu");
    飞书接({ [令牌路由]: 断三次() });
    await 出错没动("feishu", /^从飞书拉数据没成功：连不上飞书（断网或对方一直没响应，重试了 2 次）：域名解析不了/);

    飞书接({}, 青禾补电话);
    expect((await 同步一次("feishu", { 用户: 我 })).结果).toBe("成功");
    expect((await prisma.customer.findFirstOrThrow({ where: { name: "青禾食品有限公司" } })).phone).toBe("13800000003");
    expect((await 读同步设置("feishu")).拉到).not.toBeNull();
  });

  it("飞书翻页翻到一半断了：前半截也不写", async () => {
    飞书接();
    await 首次导入("feishu");
    // 第一页的星河精密改了电话，第二页断了：整次不写，星河精密还是旧号
    const 第一页 = JSON.parse(JSON.stringify(飞书录.路由[客户第一页])) as 响应[];
    const 改后 = 第一页[0].body as { data: { items: { record_id: string; last_modified_time: number; fields: Record<string, unknown> }[] } };
    改后.data.items[0].fields.电话 = "13900000009";
    改后.data.items[0].last_modified_time = 4102444800000;
    飞书接({ [客户第二页]: 断三次("ECONNRESET") }, { [客户第一页]: 第一页 });
    await 出错没动("feishu", "连接被断开");
    expect(await prisma.customer.count({ where: { phone: "13900000009" } })).toBe(0);
  });

  it("钉钉超时：出错，说等了 30 秒没响应，不挪起点、不留批次", async () => {
    钉钉接();
    await 首次导入("dingtalk");
    钉钉接({ [个人客户字段]: [超时, 超时, 超时] });
    await 出错没动("dingtalk", /^从钉钉拉数据没成功：连不上钉钉.*等了 30 秒没响应/);
  });
});

describe("同步 · 限流 / 令牌过期", () => {
  it("飞书限流（拿令牌 429、拉表 99991400）：退避后这次就同步成功", async () => {
    飞书接();
    await 首次导入("feishu");
    const n = 飞书接(
      { [令牌路由]: [{ status: 429, body: {} }], [客户字段]: [{ status: 400, body: { code: 99991400, msg: "request trigger frequency limit" } }] },
      青禾补电话,
    );
    const r = await 同步一次("feishu", { 用户: 我 });
    expect(r.结果).toBe("成功");
    expect(n.等过).toEqual([1000, 1000]);
    expect((await prisma.customer.findFirstOrThrow({ where: { name: "青禾食品有限公司" } })).phone).toBe("13800000003");
    expect(await 同步批数()).toBe(1);
  });

  it("飞书一直限流：出错，说清，不挪起点", async () => {
    飞书接();
    await 首次导入("feishu");
    飞书接({ [客户字段]: Array(6).fill({ status: 400, body: { code: 99991400, msg: "request trigger frequency limit" } }) });
    await 出错没动("feishu", "从飞书拉数据没成功");
  });

  it("飞书翻页中途令牌到期 + 接口又说令牌失效：各换一次，这次就同步成功", async () => {
    飞书接();
    await 首次导入("feishu");
    const n = 飞书接(
      {
        [客户第一页]: [{ ...飞书录.路由[客户第一页][0], 拨: 7_000_000 }],
        [`POST ${表路径("tblOpp")}/records/search`]: [{ status: 400, body: { code: 99991663, msg: "Invalid access token for authorization" } }],
      },
      青禾补电话,
    );
    expect((await 同步一次("feishu", { 用户: 我 })).结果).toBe("成功");
    expect(n.调过(令牌路由)).toHaveLength(3);
    expect((await prisma.customer.findFirstOrThrow({ where: { name: "青禾食品有限公司" } })).phone).toBe("13800000003");
  });

  it("钉钉限流 + 翻页中途令牌到期：这次就同步，不出错", async () => {
    钉钉接();
    await 首次导入("dingtalk");
    const n = 钉钉接({
      [钉令牌]: [{ status: 429, body: { code: "Throttling.Api", message: "too many requests" } }],
      [个人客户]: [{ ...钉钉录.路由[个人客户][0], 拨: 7_000_000 }],
    });
    const r = await 同步一次("dingtalk", { 用户: 我 });
    expect(r.结果).not.toBe("出错");
    expect(n.调过(钉令牌)).toHaveLength(3);
    expect((await 读同步设置("dingtalk")).拉到).not.toBeNull();
  });
});

describe("同步 · 字段改名", () => {
  const 飞书客户改名 = () => 改列名(飞书录, [客户字段, 客户第一页, 客户第二页], "电话", "联系电话");

  it("飞书把「电话」改成「联系电话」：同步停下说哪张表哪一列，不写、不挪起点；重新首次导入后接着同步", async () => {
    飞书接();
    await 首次导入("feishu");
    expect((await 已认映射("feishu"))?.列.customer?.["电话"]).toBe("phone");

    飞书接({}, 飞书客户改名());
    const r = await 出错没动("feishu", "飞书「客户」表里『电话』列不见了（可能改了名或删了），这次没写");
    expect(r.话).toContain("先重新拉全量试跑、认好列再正式导入一次");

    // 照提示：重新拉全量试跑 → 正式导入，旧名从映射里去掉、新名按规则认上
    await 首次导入("feishu");
    const m = await 已认映射("feishu");
    expect(m?.列.customer).not.toHaveProperty("电话");
    expect(m?.列.customer?.["联系电话"]).toBe("phone");
    expect((await 同步一次("feishu", { 用户: 我 })).结果).not.toBe("出错");
  });

  it("增量一条都没拉到也查得出（看列描述，不靠记录）", async () => {
    飞书接();
    await 首次导入("feishu");
    await 同步一次("feishu", { 用户: 我 }); // 「拉到」挪到现在，下一次增量就拉不到旧记录
    expect((await 读同步设置("feishu")).拉到).not.toBeNull();
    飞书接({}, 飞书客户改名());
    const r = await 同步一次("feishu", { 用户: 我 });
    expect(r).toMatchObject({ 结果: "出错" });
    expect(r.话).toContain("「客户」表里『电话』列不见了");
  });

  it("钉钉两种客户都把「电话」改了名：同步停下；只是企业客户一条没有不算改名", async () => {
    钉钉接();
    await 首次导入("dingtalk");
    钉钉接({}, 改列名(钉钉录, [个人客户字段, 企业客户字段], "电话", "联系电话"));
    await 出错没动("dingtalk", "钉钉「客户」表里『电话』列不见了");

    钉钉接({}, { [企业客户]: [{ body: { hasMore: false, maxResults: 100, values: [] } }] });
    expect((await 同步一次("dingtalk", { 用户: 我 })).结果).not.toBe("出错");
  });
});
