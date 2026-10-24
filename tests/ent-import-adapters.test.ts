/**
 * 飞书 / 钉钉适配器的契约测试：不联网，fetch 换成按官方文档响应结构录好的返回（tests/fixtures/ent-*.json）。
 * 覆盖：分页、字段缺失、限流退避、令牌过期、没权限说人话、增量；拉出来的记录直接过 规则猜列 + 清洗，父记录要都认得上。
 */
import { describe, expect, it } from "vitest";
import feishuFixture from "./fixtures/ent-feishu.json";
import dingtalkFixture from "./fixtures/ent-dingtalk.json";
import { 清洗 } from "@/lib/enterprise-import/clean";
import { 钉钉适配器, 钉钉值, 改于之后, type 钉钉配置 } from "@/lib/enterprise-import/dingtalk";
import { 飞书适配器, 飞书值, type 飞书配置 } from "@/lib/enterprise-import/feishu";
import { 规则猜列 } from "@/lib/enterprise-import/mapping";
import { 接口出错 } from "@/lib/enterprise-import/net";
import { 实体名, type 原始记录, type 实体, type 映射 } from "@/lib/enterprise-import/types";
import { 假网, 起始钟, type 录制 } from "./helpers/ent-fake-net";

/** 拉出来的记录按规则猜列、清洗一遍（值 / 负责人对照都空着，对不上的落默认负责人） */
function 走一遍(记录: 原始记录[]) {
  const 列: 映射["列"] = {};
  const 表头 = new Map<实体, Set<string>>();
  for (const r of 记录) {
    const s = 表头.get(r.实体) ?? new Set<string>();
    for (const h of Object.keys(r.字段)) s.add(h);
    表头.set(r.实体, s);
  }
  for (const [e, s] of 表头) 列[e] = 规则猜列(e, [...s]);
  const m: 映射 = { 列, 负责人: {}, 值: { 阶段: {}, 线索状态: {}, 跟进类型: {}, 跟进状态: {} }, 默认负责人Id: "u-default" };
  return 清洗(记录, m);
}

const 认不上 = new Set(["找不到客户", "客户不唯一", "找不到商机", "缺必填", "ID 重复"]);
const 按ID = (记录: 原始记录[]) => new Map(记录.map((r) => [r.外部ID, r]));

// —— 飞书 ——

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

describe("飞书适配器", () => {
  it("全量：翻页拉全四张表，空格子补成空串，关联列落到 客户ID / 商机ID", async () => {
    const n = 假网(飞书录);
    const 记录 = await new 飞书适配器(飞书, n.网).拉全量();
    expect(记录.map((r) => r.外部ID)).toEqual(["recCust1", "recCust2", "recCust3", "recCont1", "recCont2", "recOpp1", "recFol1", "recFol2"]);

    const 客户搜 = n.调过(`POST ${表路径("tblCust")}/records/search`);
    expect(客户搜.map((c) => c.键)).toEqual([`POST ${表路径("tblCust")}/records/search`, `POST ${表路径("tblCust")}/records/search?page_token=p2`]);
    expect(客户搜[0].body).toEqual({ automatic_fields: true });
    expect(n.调过(令牌路由)).toHaveLength(1);
    expect(n.等过).toEqual([]);

    const r = 按ID(记录);
    expect(r.get("recCust1")!.字段).toMatchObject({
      记录ID: "recCust1",
      客户名称: "星河精密制造有限公司",
      行业: "制造业",
      负责人: "张伟",
      电话: "13800000001",
      地址: "浙江省杭州市西湖区文三路 100 号",
      创建时间: "2026-10-01 09:00",
    });
    expect(r.get("recCust1")!.出处).toBe(`飞书 · ${实体名.customer}表`);
    // 飞书不返回空格子，按列表补齐
    expect(r.get("recCust3")!.字段).toMatchObject({ 客户名称: "青禾食品有限公司", 负责人: "", 电话: "", 行业: "", 地址: "" });
    expect(r.get("recCont1")!.字段).toMatchObject({ 姓名: "王磊", 客户ID: "recCust1", 职位: "采购经理" });
    expect(r.get("recCont1")!.字段).not.toHaveProperty("所属客户");
    expect(r.get("recCont2")!.字段).toMatchObject({ 客户ID: "recCust3", 手机: "", 职位: "" });
    expect(r.get("recOpp1")!.字段).toMatchObject({ 客户ID: "recCust1", 金额: "120000", 阶段: "方案报价", 预计成交日期: "2026-11-08", 客户行业: "制造业" });
    expect(r.get("recFol1")!.字段).toMatchObject({ 客户ID: "recCust1", 商机ID: "recOpp1", 跟进方式: "电话", 跟进人: "张伟", 跟进时间: "2026-10-22 10:15" });
    expect(r.get("recFol2")!.字段).toMatchObject({ 客户ID: "recCust2", 商机ID: "" });
  });

  it("拉出来的直接过规则猜列 + 清洗：父记录全认得上，一条不丢", async () => {
    const 记录 = await new 飞书适配器(飞书, 假网(飞书录).网).拉全量();
    const 结果 = 走一遍(记录);
    expect(结果.问题.filter((q) => 认不上.has(q.类别))).toEqual([]);
    expect(结果.待写).toHaveLength(记录.length);
    const w = new Map(结果.待写.map((x) => [x.外部ID, x]));
    expect(w.get("recCont1")!.父客户).toEqual({ 外部ID: "recCust1" });
    expect(w.get("recCont2")!.父客户).toEqual({ 外部ID: "recCust3" });
    expect(w.get("recOpp1")!.父客户).toEqual({ 外部ID: "recCust1" });
    expect(w.get("recFol1")!.父客户).toEqual({ 外部ID: "recCust1" });
    expect(w.get("recFol1")!.父商机).toEqual({ 外部ID: "recOpp1" });
    expect(w.get("recFol2")!.父客户).toEqual({ 外部ID: "recCust2" });
  });

  it("增量：只要 since 之后改过的（飞书搜索接口按 last_modified_time 在本地筛）", async () => {
    const 记录 = await new 飞书适配器(飞书, 假网(飞书录).网).拉变化(new Date(1792600000000));
    expect(记录.map((r) => r.外部ID)).toEqual(["recCust2", "recCont2", "recOpp1", "recFol1"]);
  });

  it("appToken / tableId 带了 / ? # 也原样编码进路径，不会拼到别的接口上", async () => {
    const 怪 = { 实体: "customer" as const, appToken: "bas/cn?x#y", tableId: "tbl&1" };
    const 路 = `/open-apis/bitable/v1/apps/${encodeURIComponent(怪.appToken)}/tables/${encodeURIComponent(怪.tableId)}`;
    const 空 = { body: { code: 0, data: { items: [], has_more: false } } };
    const n = 假网(飞书录, { [`GET ${路}/fields`]: [空], [`POST ${路}/records/search`]: [空] });
    expect(await new 飞书适配器({ ...飞书, 表们: [怪] }, n.网).拉全量()).toEqual([]);
    expect(n.调用们.filter((c) => c.键 !== 令牌路由).map((c) => new URL(c.url).pathname)).toEqual([`${路}/fields`, `${路}/records/search`]);
  });

  it("限流（HTTP 429、99991400、1254290）：1s、2s、4s 退避后接着拉", async () => {
    const n = 假网(飞书录, {
      [`GET ${表路径("tblCust")}/fields`]: [{ status: 429, body: {} }, { status: 400, body: { code: 99991400, msg: "request trigger frequency limit" } }],
      [`POST ${表路径("tblOpp")}/records/search`]: [{ body: { code: 1254290, msg: "TooManyRequest" } }],
    });
    const 记录 = await new 飞书适配器(飞书, n.网).拉全量();
    expect(记录).toHaveLength(8);
    expect(n.等过).toEqual([1000, 2000, 1000]);
  });

  it("一直限流：重试 5 次（1→16 秒）后报错，不死等", async () => {
    const 限 = { status: 400, body: { code: 99991400, msg: "request trigger frequency limit" } };
    const n = 假网(飞书录, { [`GET ${表路径("tblCust")}/fields`]: Array(6).fill(限) });
    await expect(new 飞书适配器(飞书, n.网).拉全量()).rejects.toThrow(接口出错);
    expect(n.等过).toEqual([1000, 2000, 4000, 8000, 16000]);
  });

  it("令牌过期（99991663）：换一次令牌，用新令牌重试", async () => {
    const n = 假网(飞书录, { [`POST ${表路径("tblCust")}/records/search`]: [{ status: 400, body: { code: 99991663, msg: "Invalid access token for authorization" } }] });
    const 记录 = await new 飞书适配器(飞书, n.网).拉全量();
    expect(记录).toHaveLength(8);
    expect(n.调过(令牌路由)).toHaveLength(2);
    const 搜 = n.调过(`POST ${表路径("tblCust")}/records/search`);
    expect(搜[0].headers.Authorization).toBe("Bearer t-fake-1");
    expect(搜[1].headers.Authorization).toBe("Bearer t-fake-2");
  });

  it("换了令牌还说过期：报错，不来回换", async () => {
    const 过期 = { status: 400, body: { code: 99991663, msg: "Invalid access token for authorization" } };
    const n = 假网(飞书录, { [`POST ${表路径("tblCust")}/records/search`]: [过期, 过期] });
    await expect(new 飞书适配器(飞书, n.网).拉全量()).rejects.toThrow(接口出错);
    expect(n.调过(令牌路由)).toHaveLength(2);
  });

  it("没权限：说清是哪张表、去哪里开", async () => {
    const n = 假网(飞书录, { [`POST ${表路径("tblCust")}/records/search`]: [{ status: 403, body: { code: 91403, msg: "Forbidden" } }] });
    const 拉 = new 飞书适配器(飞书, n.网).拉全量();
    await expect(拉).rejects.toThrow(接口出错);
    await expect(拉).rejects.toThrow(/客户表.*添加文档应用/);
  });

  it("App Secret 不对：拿令牌时就说清", async () => {
    const n = 假网(飞书录, { [令牌路由]: [{ body: { code: 10014, msg: "app secret invalid" } }] });
    await expect(new 飞书适配器(飞书, n.网).拉全量()).rejects.toThrow(/App Secret 不对/);
  });

  it("飞书值：文本段直接拼、多选人员用顿号、日期给北京时间、查找引用拆开", () => {
    expect(飞书值([{ text: "星河", type: "text" }, { text: "精密", type: "text" }], 1)).toBe("星河精密");
    expect(飞书值(["制造业", "物流"], 4)).toBe("制造业、物流");
    expect(飞书值([{ id: "ou_1", name: "张伟" }, { id: "ou_2", name: "李娜" }], 11)).toBe("张伟、李娜");
    expect(飞书值(1794067200000, 5)).toBe("2026-11-08");
    expect(飞书值(1792635300000, 5)).toBe("2026-10-22 10:15");
    expect(飞书值(120000, 2)).toBe("120000");
    expect(飞书值(true, 7)).toBe("是");
    expect(飞书值({ type: 3, value: ["制造业"] }, 19)).toBe("制造业");
    expect(飞书值(null)).toBe("");
  });
});

// —— 钉钉 ——

const 钉钉: 钉钉配置 = { appKey: "ding-fake", appSecret: "fake-secret", 操作人UserId: "manager01", 商机表单code: "PROC-FAKE-OPP" };
const 钉钉录 = dingtalkFixture as unknown as 录制;
const 钉令牌 = "POST /v1.0/oauth2/accessToken";
const 个人客户字段 = "GET /v1.0/crm/personalCustomers/objectMeta?relationType=crm_customer_personal";
const 个人客户 = "GET /v1.0/crm/personalCustomers?relationType=crm_customer_personal";

describe("钉钉适配器", () => {
  it("全量：个人 + 企业客户、联系人、商机、跟进翻页拉全，key 换中文列名、关联落到 客户ID / 商机ID、userId 换名字", async () => {
    const n = 假网(钉钉录);
    const 记录 = await new 钉钉适配器(钉钉, n.网, 0).拉全量();
    expect(记录.map((r) => r.外部ID)).toEqual(["dtCust1", "dtCust2", "dtCust3", "dtCorp1", "dtCont1", "dtCont2", "dtOpp1", "dtFol1", "dtFol2"]);

    expect(n.调过(个人客户).map((c) => c.键)).toEqual([个人客户, `${个人客户}&nextToken=nt2`]);
    expect(n.调过("POST /topapi/crm/objectdata/followrecord/query").map((c) => c.键)).toEqual([
      "POST /topapi/crm/objectdata/followrecord/query?cursor=0",
      "POST /topapi/crm/objectdata/followrecord/query?cursor=c2",
    ]);
    const 首页 = new URL(n.调过(个人客户)[0].url);
    expect(首页.searchParams.get("currentOperatorUserId")).toBe("manager01");
    expect(首页.searchParams.get("maxResults")).toBe("100");
    expect(首页.searchParams.has("queryDsl")).toBe(false);
    expect(n.调过(钉令牌)).toHaveLength(1);
    // 同一个人只查一次名字
    expect(n.调过("POST /topapi/v2/user/get?userid=u001")).toHaveLength(1);

    const r = 按ID(记录);
    expect(r.get("dtCust1")!.字段).toEqual({
      记录ID: "dtCust1",
      客户名称: "星河精密制造有限公司",
      电话: "13800000001",
      行业: "制造业",
      地址: "浙江省杭州市西湖区文三路 100 号",
      负责人: "张伟",
    });
    expect(r.get("dtCust1")!.出处).toBe("钉钉 · 个人客户");
    expect(r.get("dtCust2")!.字段).toMatchObject({ 地址: "", 负责人: "李娜" });
    // 缺的字段补空串；通讯录查不到的人退回 userId（清洗时报负责人对不上）
    expect(r.get("dtCust3")!.字段).toMatchObject({ 电话: "", 行业: "", 地址: "", 负责人: "u003" });
    expect(r.get("dtCorp1")!.出处).toBe("钉钉 · 企业客户");
    expect(r.get("dtCorp1")!.字段).not.toHaveProperty("负责人");
    expect(r.get("dtCont1")!.字段).toMatchObject({ 姓名: "王磊", 所属客户: "星河精密制造有限公司", 客户ID: "dtCust1", 职位: "采购经理", 负责人: "张伟" });
    expect(r.get("dtCont2")!.字段).toMatchObject({ 客户ID: "dtCust3", 手机: "", 职位: "" });
    expect(r.get("dtOpp1")!.字段).toMatchObject({ 商机名称: "二期产线改造", 客户: "星河精密制造有限公司", 客户ID: "dtCust1", 金额: "120000", 阶段: "方案报价", 预计成交日期: "2026-11-08" });
    expect(r.get("dtOpp1")!.字段).not.toHaveProperty("商机ID");
    expect(r.get("dtFol1")!.字段).toMatchObject({ 客户ID: "dtCust1", 商机ID: "dtOpp1", 关联商机: "二期产线改造", 跟进方式: "电话", 跟进时间: "2026-10-22 10:15", 负责人: "张伟" });
    // 负责人列表空着就用创建人
    expect(r.get("dtFol2")!.字段).toMatchObject({ 客户ID: "dtCust2", 关联商机: "", 跟进方式: "拜访", 负责人: "李娜" });
  });

  it("拉出来的直接过规则猜列 + 清洗：父记录全认得上，一条不丢", async () => {
    const 记录 = await new 钉钉适配器(钉钉, 假网(钉钉录).网, 0).拉全量();
    const 结果 = 走一遍(记录);
    expect(结果.问题.filter((q) => 认不上.has(q.类别))).toEqual([]);
    expect(结果.待写).toHaveLength(记录.length);
    const w = new Map(结果.待写.map((x) => [x.外部ID, x]));
    expect(w.get("dtCont1")!.父客户).toEqual({ 外部ID: "dtCust1" });
    expect(w.get("dtCont2")!.父客户).toEqual({ 外部ID: "dtCust3" });
    expect(w.get("dtOpp1")!.父客户).toEqual({ 外部ID: "dtCust1" });
    expect(w.get("dtFol1")!.父商机).toEqual({ 外部ID: "dtOpp1" });
    expect(w.get("dtFol2")!.父客户).toEqual({ 外部ID: "dtCust2" });
  });

  it("没配商机表单就不拉商机", async () => {
    const n = 假网(钉钉录);
    const 记录 = await new 钉钉适配器({ ...钉钉, 商机表单code: undefined }, n.网, 0).拉全量();
    expect(记录.some((r) => r.实体 === "opportunity")).toBe(false);
    expect(n.调过("POST /v1.0/crm/customObjects/datas/query")).toHaveLength(0);
    // 跟进里的「关联商机」只是文字，不放 商机ID
    expect(按ID(记录).get("dtFol1")!.字段).not.toHaveProperty("商机ID");
  });

  it("增量：三种接口都带上 gmt_modified 在 (since, 现在] 的查询条件", async () => {
    const n = 假网(钉钉录);
    const since = 1792600000000;
    await new 钉钉适配器(钉钉, n.网, 0).拉变化(new Date(since));
    const dsl = 改于之后(since, 起始钟);
    expect(new URL(n.调过(个人客户)[0].url).searchParams.get("queryDsl")).toBe(dsl);
    expect(n.调过("POST /v1.0/crm/customObjects/contacts/datas/query")[0].body?.queryDsl).toBe(dsl);
    expect(n.调过("POST /topapi/crm/objectdata/followrecord/query")[0].body?.query_dsl).toBe(dsl);
    expect(JSON.parse(dsl).queryGroupList[0].queryObjectList[0].value).toEqual([String(since + 1), String(起始钟)]);
  });

  it("节流：两次调用之间至少隔 1.1 秒（钉钉 CRM 默认 1 秒 1 次）", async () => {
    const n = 假网(钉钉录);
    await new 钉钉适配器(钉钉, n.网).拉全量();
    expect(n.等过.length).toBeGreaterThan(10);
    expect(n.等过.every((ms) => ms === 1100)).toBe(true);
  });

  it("限流（429、request.too.frequent、QpsLimit、老接口 90018）：退避后接着拉", async () => {
    const n = 假网(钉钉录, {
      [个人客户字段]: [
        { status: 429, body: { code: "Throttling.Api", message: "too many requests" } },
        { status: 403, body: { code: "Forbidden.AccessDenied.QpsLimitForApi", message: "qps limit" } },
      ],
      [个人客户]: [{ status: 400, body: { code: "request.too.frequent", message: "请求太频繁" } }],
      "POST /topapi/crm/objectmeta/followrecord/describe": [{ body: { errcode: 90018, errmsg: "当前企业调用该接口超过限制" } }],
    });
    const 记录 = await new 钉钉适配器(钉钉, n.网, 0).拉全量();
    expect(记录).toHaveLength(9);
    expect(n.等过).toEqual([1000, 2000, 1000, 1000]);
  });

  it("一直限流：重试 5 次后报错", async () => {
    const 限 = { status: 429, body: { code: "Throttling.Api", message: "too many requests" } };
    const n = 假网(钉钉录, { [个人客户字段]: Array(6).fill(限) });
    await expect(new 钉钉适配器(钉钉, n.网, 0).拉全量()).rejects.toThrow(接口出错);
    expect(n.等过).toEqual([1000, 2000, 4000, 8000, 16000]);
  });

  it("令牌过期：新接口 401 / 老接口 40014 都换一次令牌重试", async () => {
    const n = 假网(钉钉录, {
      [个人客户字段]: [{ status: 401, body: { code: "InvalidAuthentication", message: "不合法的access_token" } }],
      "POST /topapi/crm/objectmeta/contact/describe": [{ body: { errcode: 40014, errmsg: "不合法的access_token" } }],
    });
    const 记录 = await new 钉钉适配器(钉钉, n.网, 0).拉全量();
    expect(记录).toHaveLength(9);
    // 第一次：一开始拿；第二次：新接口过期；第三次：老接口过期
    expect(n.调过(钉令牌)).toHaveLength(3);
    const 元 = n.调过(个人客户字段);
    expect(元[0].headers["x-acs-dingtalk-access-token"]).toBe("dt-fake-1");
    expect(元[1].headers["x-acs-dingtalk-access-token"]).toBe("dt-fake-2");
    const 联 = n.调过("POST /topapi/crm/objectmeta/contact/describe");
    expect(new URL(联[1].url).searchParams.get("access_token")).toBe("dt-fake-2");
  });

  it("没权限：新接口、老接口都说清去哪里开", async () => {
    const 新 = 假网(钉钉录, { [个人客户]: [{ status: 403, body: { code: "Forbidden.AccessDenied.AccessTokenPermissionDenied", message: "没有调用该接口的权限" } }] });
    await expect(new 钉钉适配器(钉钉, 新.网, 0).拉全量()).rejects.toThrow(/拉客户出错.*开 CRM 相关权限/);
    const 老 = 假网(钉钉录, { "POST /topapi/crm/objectdata/followrecord/query?cursor=0": [{ body: { errcode: 60011, errmsg: "no permission" } }] });
    await expect(new 钉钉适配器(钉钉, 老.网, 0).拉全量()).rejects.toThrow(/拉跟进记录出错.*开 CRM 相关权限/);
  });

  it("钉钉值：关联列给实例 ID 和类型、成员列给名字或 userId、串里的 JSON 拆开", () => {
    const 关联 = JSON.stringify({ value: "x", extendValue: JSON.stringify({ list: [{ instanceId: "i1", name: "星河", bizType: "crm_customer" }] }) });
    expect(钉钉值(关联)).toEqual({ 文本: "星河", 指向ID: "i1", 指向类型: "crm_customer", 人们: [] });
    expect(钉钉值({ value: "", extendValue: '[{"userId":"u9"}]' })).toEqual({ 文本: "", 人们: ["u9"] });
    expect(钉钉值({ value: "", extendValue: '[{"userId":"u9","name":"王五"}]' })).toEqual({ 文本: "王五", 人们: [] });
    expect(钉钉值({ value: "方案报价", extendValue: '{"label":"方案报价","key":"option_2"}' })).toEqual({ 文本: "方案报价", 人们: [] });
    expect(钉钉值({ extendValue: '{"label":"电话"}' })).toEqual({ 文本: "电话", 人们: [] });
    expect(钉钉值(["A", "B"])).toEqual({ 文本: "A、B", 人们: [] });
    expect(钉钉值(false)).toEqual({ 文本: "否", 人们: [] });
    expect(钉钉值(null)).toEqual({ 文本: "", 人们: [] });
  });
});
