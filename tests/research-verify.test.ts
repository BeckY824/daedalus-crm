/**
 * 背调的「真实性」那一块（lib/research/verify/*，2026-10-18）。不连网：接口一律用假 fetch / 假依赖。
 *
 * 钉的主要是「什么时候标红」——红是要劝用户别做的，冤枉一家正经公司比漏掉一个骗子代价更大：
 *   仿冒邮箱域名只在注册得新时才红；工商库已注销只在名字一字不差、又没有同名存续时才红；
 *   制裁名单只在名字一字不差、国家也对得上时才红；停放页只认短页面。
 * 以及总灯、「信息少，谨慎」横幅全由代码定。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { 比名字, 名词, 查询名, 提到了 } from "@/lib/research/verify/names";
import { 主机, 主域名, 名段, 是免费邮箱, 比域名 } from "@/lib/research/verify/domain";
import { 认国家, 国名, 同一国 } from "@/lib/research/verify/country";
import { 认足迹, 是社媒网址, 社媒查询 } from "@/lib/research/verify/social";
import { 查邮箱, 查电话 } from "@/lib/research/verify/contact";
import { 认停放页 } from "@/lib/research/verify/site";
import { 解CSV, 解OFAC, 解EU行, 解UN, 解UK行, 比名单, 制裁项, type 名单 } from "@/lib/research/verify/sanctions";
import { 查工商, 挑登记, 认税号, 查税号, 国家库, 设美国重试毫秒, type 登记 } from "@/lib/research/verify/registry";
import { 认线索, 合并线索 } from "@/lib/research/verify/clues";
import { 核验, 域名项 } from "@/lib/research/verify/check";
import { 定总灯, 合成真实性, 信息少, 独立来源数 } from "@/lib/research/verify/rules";
import type { 核验项 } from "@/lib/research/verify/types";
import { 初始状态, 归约 } from "@/lib/research/state";
import { 报告文本 } from "@/lib/research/report";
import type { 研究事件 } from "@/lib/research/types";

const 前 = (天: number) => new Date(Date.now() - 天 * 86400_000).toISOString().slice(0, 10);
const 年龄 = (天: number) => async () => ({ 有: true as const, 日期: 前(天), 依据: "RDAP" as const, 下限: false, 链接: "https://rdap.example/x" });
const 有MX = async () => true;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("公司名比对", () => {
  it("去掉公司类型后缀、重音；一字不差是「同」，多一两个词是「近」，别的不认", () => {
    expect(名词("Rexel France S.A.S.")).toEqual(["rexel", "france"]);
    expect(比名字("SLV GmbH", "SLV")).toBe("同");
    expect(比名字("Électricité Martin SARL", "electricite martin")).toBe("同");
    expect(比名字("Delta Light", "DeltaLight NV")).toBe("同");
    expect(比名字("SLV", "SLV Lighting Group GmbH")).toBe("近");
    expect(比名字("SLV", "SLV Lighting Group Europe Holding")).toBeNull();
    expect(比名字("Ansell Lighting", "Rexel")).toBeNull();
  });
  it("查询名去掉中文说明；提到了 按词认，不从长词里抠", () => {
    expect(查询名("SLV 德国")).toBe("SLV");
    expect(查询名("杭州某某照明")).toBe("杭州某某照明");
    expect(提到了("Sales Manager at SLV GmbH | LinkedIn", "SLV")).toBe(true);
    expect(提到了("SLVR Industries", "SLV")).toBe(false);
    expect(提到了("deltalight belgium", "Delta Light")).toBe(true);
  });
});

describe("域名", () => {
  it("主机、主域名（两级后缀）、名段", () => {
    expect(主机("https://WWW.slv.com/de/?a=1")).toBe("www.slv.com");
    expect(主机("john@slv.co.uk")).toBe("slv.co.uk");
    expect(主机("not a domain")).toBeUndefined();
    expect(主域名("shop.ansell.co.uk")).toBe("ansell.co.uk");
    expect(主域名("www.rexel.fr")).toBe("rexel.fr");
    expect(名段("ansell.co.uk")).toBe("ansell");
  });
  it("免费邮箱", () => {
    expect(是免费邮箱("buyer@gmail.com")).toBe(true);
    expect(是免费邮箱("x@yahoo.co.uk")).toBe(true);
    expect(是免费邮箱("x@slv.com")).toBe(false);
  });
  it("邮箱域名和官网的关系：同一家 / 换后缀 / 加了词 / 形近 / 无关", () => {
    expect(比域名("mail.slv.com", "slv.com")).toBe("同一家");
    expect(比域名("slv.co", "slv.com")).toBe("换后缀");
    expect(比域名("slv-lighting.com", "slv.com")).toBe("加了词");
    expect(比域名("rexelgroup.net", "rexel.com")).toBe("加了词");
    expect(比域名("rexe1.com", "rexel.com")).toBe("形近");
    expect(比域名("rexle.com", "rexel.com")).toBe("形近");
    expect(比域名("s1v.com", "slv.com")).toBe("形近");
    expect(比域名("alibaba.com", "slv.com")).toBe("无关");
  });
});

describe("国家", () => {
  it("中文、英文、简称、两位码都认成同一个码；英文按整词认", () => {
    expect(认国家("德国·汉堡")).toBe("DE");
    expect(认国家("Hamburg, Germany")).toBe("DE");
    expect(认国家("阿联酋迪拜")).toBe("AE");
    expect(认国家("UK")).toBe("GB");
    expect(认国家("fr")).toBe("FR");
    expect(认国家("Dubai, UAE")).toBe("AE");
    expect(认国家("")).toBeUndefined();
    // 作废的旧码不能抢走现在的国家（DD 东德、SU 苏联、FX 法国本土）
    expect(认国家("德国")).toBe("DE");
    expect(认国家("Russia")).toBe("RU");
    expect(认国家("France")).toBe("FR");
    expect(认国家("European Union")).toBeUndefined();
    expect(国名("AE")).toBe("阿联酋");
    expect(同一国("GG", "GB")).toBe(true);
    expect(同一国("US", "GB")).toBe(false);
  });
});

describe("网上足迹（只看搜索结果，不打开页面）", () => {
  it("一条 Facebook 定向搜索（LinkedIn 搜索不收录）；社媒网址认得出", () => {
    expect(社媒查询("SLV 德国")).toEqual(['"SLV" site:facebook.com']);
    expect(是社媒网址("https://de.linkedin.com/company/slv")).toBe(true);
    expect(是社媒网址("https://www.facebook.com/slvlighting")).toBe(true);
    expect(是社媒网址("https://slv.com")).toBe(false);
  });
  it("公司主页、在职员工、Facebook 主页分开认；别家的、搜索页不算", () => {
    const x = 认足迹(
      [
        { title: "SLV GmbH | LinkedIn", url: "https://www.linkedin.com/company/slv-gmbh/", snippet: "" },
        { title: "Anna Müller - Sales Manager - SLV GmbH | LinkedIn", url: "https://de.linkedin.com/in/anna-m", snippet: "" },
        { title: "Bob - Engineer - Other Co | LinkedIn", url: "https://de.linkedin.com/in/bob", snippet: "" },
        { title: "SLV", url: "https://www.facebook.com/search/top?q=slv", snippet: "" },
        { title: "SLV Lighting", url: "https://www.facebook.com/slv.lighting", snippet: "" },
        { title: "SLV GmbH", url: "https://www.linkedin.com/company/slv-gmbh?trk=x", snippet: "" },
      ],
      "SLV",
      true,
    );
    expect(x).toMatchObject({ 灯: "green", 态: "已核" });
    expect(x.事实).toBe("Facebook 主页：有（SLV Lighting）；LinkedIn：公司主页有、搜到在职员工");
    expect(x.链接?.map((l) => l.url)).toEqual(["https://www.linkedin.com/company/slv-gmbh/", "https://de.linkedin.com/in/anna-m", "https://www.facebook.com/slv.lighting"]);
  });
  it("Facebook 主页下的帖子算那个主页（10-18 bench：搜到的多是 /RexelFR/posts/…）；别家主页的帖子、graph 图片不算", () => {
    const x = 认足迹(
      [
        { title: "Rexel France - Découvrez la toute nouvelle application... - Facebook", url: "https://www.facebook.com/RexelFR/posts/-d%C3%A9couvrez-la/784486757016022/", snippet: "" },
        { title: "Rexel France - Bizline vous présente... Facebook", url: "https://www.facebook.com/RexelFR/videos/easy-cee/2052327971816199/", snippet: "" },
      ],
      "Rexel France",
      true,
    );
    expect(x).toMatchObject({ 灯: "green", 态: "已核" });
    expect(x.链接).toEqual([{ title: "Rexel France（Facebook 主页）", url: "https://www.facebook.com/RexelFR" }]);
    // 萨尔瓦多经销商 AlfaLight 的帖子里提到 deltalight、Ansell 那条是 graph 接口的头像图：都不是这家的主页
    const 别家 = 认足迹(
      [
        { title: "Facebook", url: "https://www.facebook.com/AlfaLight.sv/posts/iluminaci%C3%B3n-deltalight-elsalvador/963376393729968/", snippet: "Iluminación Delta Light" },
        { title: "AlfaLight - Iluminación Delta Light en El Salvador", url: "https://www.facebook.com/AlfaLight.sv/posts/x/1/", snippet: "" },
        { title: "graph.facebook.com", url: "https://graph.facebook.com/v2.8/2083225758519903/picture/", snippet: "" },
        { title: "Delta Light", url: "https://www.facebook.com/permalink.php?story_fbid=1", snippet: "" },
        { title: "Finalisation de l’étage bientôt le reste de la maison !! #DeltaLight# ...", url: "https://www.facebook.com/electrodesign95/videos/finalisation/1522614678182577/", snippet: "" },
      ],
      "Delta Light",
      true,
    );
    expect(别家).toMatchObject({ 灯: "yellow", 态: "没查到" });
  });
  it("全未搜到标黄（不标红）；一次都没搜成是「查不了」", () => {
    expect(认足迹([], "Ghost Trading", true)).toMatchObject({ 灯: "yellow", 态: "没查到" });
    expect(认足迹([], "Ghost Trading", false)).toMatchObject({ 灯: "gray", 态: "查不了" });
  });
});

describe("邮箱", () => {
  const 深 = { 查MX: 有MX, 查年龄: 年龄(4000) };
  it("没给是「没提供」；和官网同一个域名是绿", async () => {
    expect(await 查邮箱([], "slv.com", 深)).toMatchObject({ 态: "没提供", 灯: "gray" });
    expect(await 查邮箱(["Anna@SLV.com"], "slv.com", 深)).toMatchObject({ 灯: "green", 态: "已核" });
  });
  it("免费邮箱、不相干的企业邮箱、没有 MX：标黄", async () => {
    expect((await 查邮箱(["buyer@gmail.com"], "slv.com", 深)).灯).toBe("yellow");
    expect((await 查邮箱(["a@foo-trading.com"], "slv.com", 深)).灯).toBe("yellow");
    const 无MX = await 查邮箱(["a@slv.com"], "slv.com", { 查MX: async () => false, 查年龄: 年龄(4000) });
    expect(无MX.灯).toBe("yellow");
    expect(无MX.事实).toContain("没有收信记录");
  });
  it("像官网的新域名硬红；老的（大公司别国的域名）只标黄", async () => {
    const 新 = await 查邮箱(["sales@slv-lighting.com"], "slv.com", { 查MX: 有MX, 查年龄: 年龄(40) });
    expect(新.灯).toBe("red");
    expect(新.硬红).toContain("仿冒");
    const 老 = await 查邮箱(["sales@slv.de"], "slv.com", 深);
    expect(老.灯).toBe("yellow");
    expect(老.硬红).toBeUndefined();
    expect(老.事实).toContain("可能是同一家的另一个域名");
    // 形近（差一个字母）门槛更高：一年多也算仿冒；查不到年龄也红
    expect((await 查邮箱(["a@rexe1.com"], "rexel.com", { 查MX: 有MX, 查年龄: 年龄(500) })).灯).toBe("red");
    expect((await 查邮箱(["a@rexe1.com"], "rexel.com", { 查MX: 有MX, 查年龄: async () => ({ 有: false, 查不了: true }) })).灯).toBe("red");
  });
});

describe("电话（libphonenumber，本地判）", () => {
  it("有效号码：国家、类型；和自报国家对不上标黄", () => {
    // 020 7946 0xxx 是 Ofcom 留给影视剧的虚构号段（见下面那条），这里用普通的伦敦号
    const 英 = 查电话(["+44 20 7123 4567"], "GB");
    expect(英).toMatchObject({ 灯: "green", 态: "已核" });
    expect(英.事实).toContain("英国固话");
    const 迪拜用英国手机 = 查电话(["+44 7911 123456"], "AE");
    expect(迪拜用英国手机.灯).toBe("yellow");
    expect(迪拜用英国手机.事实).toContain("对不上");
    // +44 7911… 归属是根西岛（GG），按英国算
    expect(查电话(["+44 7911 123456"], "GB").灯).toBe("green");
  });
  it("虚构号码（Ofcom 影视剧号段 / 北美 555-01xx）亮红，写明「这是虚构号码」", () => {
    const 伦敦 = 查电话(["+44 20 7946 0123"], "GB");
    expect(伦敦).toMatchObject({ 灯: "red", 态: "已核" });
    expect(伦敦.事实).toContain("这是虚构号码");
    expect(伦敦.事实).toContain("伦敦 020 7946 0xxx");
    // 本国写法，按公司国家认
    expect(查电话(["0114 496 0999"], "GB").灯).toBe("red");
    expect(查电话(["+1 415 555 0132"], "US").灯).toBe("red");
    // 一个真号一个虚构：取最坏
    expect(查电话(["+44 20 7123 4567", "+44 7700 900123"], "GB").灯).toBe("red");
  });
  it("无效号码标黄；没给是「没提供」", () => {
    expect(查电话(["+49 123"], "DE").态).toBe("没提供");
    expect(查电话(["+1 000 000 0000"], "US").灯).toBe("yellow");
    expect(查电话([], "US").态).toBe("没提供");
  });
});

describe("官网停放页", () => {
  it("短的停放页 / 模板页才算；长页面里提一句不算", () => {
    expect(认停放页("slv-x.com", "This domain is for sale! Buy this domain today.", "https://slv-x.com/")).toContain("停放");
    expect(认停放页("Welcome to nginx!", "Welcome to nginx! If you see this page…", "https://a.com/")).toContain("模板");
    expect(认停放页("x", "anything", "https://sedo.com/search?x")).toContain("域名交易站");
    expect(认停放页("Domain brokers", `${"We sell premium domains. ".repeat(200)} domain names for sale`, "https://broker.com/")).toBeNull();
    expect(认停放页("SLV", "Lighting products ".repeat(100), "https://slv.com/")).toBeNull();
  });
});

describe("制裁名单", () => {
  it("四份名单的格式", () => {
    expect(解CSV('a,"b,c",d\n1,"x ""y""",3')).toEqual([["a", "b,c", "d"], ["1", 'x "y"', "3"]]);
    const ofac = 解OFAC('36,"AEROCARIBBEAN AIRLINES",-0- ,"CUBA"\n7,"JOHN DOE","individual","SDGT"', '36,1,"Havana",,"Cuba"', '36,1,"aka","AERO-CARIBBEAN",""');
    expect(ofac).toHaveLength(1);
    expect(ofac[0]).toMatchObject({ 名: ["AEROCARIBBEAN AIRLINES", "AERO-CARIBBEAN"], 国: ["CU"], 号: "OFAC 36" });

    const eu = 解EU行();
    eu.行(["Entity_LogicalId", "Entity_SubjectType_ClassificationCode", "NameAlias_WholeName", "Address_CountryIso2Code", "Entity_EU_ReferenceNumber", "Entity_Regulation_PublicationUrl"]);
    eu.行(["13", "enterprise", "Bad Corp LLC", "RU", "EU.1.2", "https://eur-lex.example/1"]);
    eu.行(["13", "enterprise", "Bad Corporation", "00", "EU.1.2", ""]);
    eu.行(["14", "person", "Ivan", "RU", "EU.1.3", ""]);
    expect(eu.完()).toEqual([{ 名: ["Bad Corp LLC", "Bad Corporation"], 国: ["RU"], 链: "https://eur-lex.example/1", 号: "EU.1.2" }]);

    const un = 解UN("<ENTITIES><ENTITY><DATAID>1</DATAID><FIRST_NAME>AL-X &amp; CO</FIRST_NAME><REFERENCE_NUMBER>QDe.1</REFERENCE_NUMBER><ENTITY_ALIAS><ALIAS_NAME>X Co</ALIAS_NAME></ENTITY_ALIAS><ENTITY_ADDRESS><COUNTRY>Syrian Arab Republic</COUNTRY></ENTITY_ADDRESS></ENTITY></ENTITIES>");
    expect(un[0]).toMatchObject({ 名: ["AL-X & CO", "X Co"], 国: ["SY"], 号: "UN QDe.1" });

    const uk = 解UK行();
    uk.行(["Report Date: 17-Oct-2026"]);
    uk.行(["Unique ID", "Designation Type", "Name 6", "Name 1", "Address Country"]);
    uk.行(["RUS0001", "Entity", "Evil Trading", "", "Russia"]);
    uk.行(["RUS0002", "Individual", "Smith", "John", "Russia"]);
    expect(uk.完()).toEqual([{ 名: ["Evil Trading"], 国: ["RU"], 链: "https://www.gov.uk/government/publications/the-uk-sanctions-list", 号: "UK RUS0001" }]);
  });

  const 单: 名单[] = [
    { 名: "OFAC", 更新于: "2026-10-18T01:00:00Z", 条: [{ 名: ["Evil Trading LLC"], 国: ["RU"], 链: "https://ofac.example/1", 号: "OFAC 1" }] },
    { 名: "EU", 更新于: "2026-10-17T01:00:00Z", 条: [{ 名: ["Rexel"], 国: ["IR"], 链: "https://eu.example/2", 号: "EU.2" }] },
  ];
  it("名字一字不差、国家也对上才红；只是同名标黄；没命中是绿", () => {
    expect(比名单(单, ["Evil Trading"], "RU")[0]).toMatchObject({ 名单: "OFAC", 国家对上: true });
    const 红 = 制裁项(单, ["Evil Trading GmbH"], "RU");
    expect(红.灯).toBe("red");
    expect(红.硬红).toContain("疑似命中");
    const 同名 = 制裁项(单, ["Rexel"], "FR");
    expect(同名.灯).toBe("yellow");
    expect(同名.硬红).toBeUndefined();
    const 干净 = 制裁项(单, ["SLV GmbH"], "DE");
    expect(干净).toMatchObject({ 灯: "green", 态: "已核" });
    expect(干净.事实).toContain("未命中（名单更新于 10-17；联合国、英国名单这次没下下来）");
    // 「Evil」不能命中「Evil Trading」：只认整名
    expect(制裁项(单, ["Evil"], "RU").灯).toBe("green");
    expect(制裁项([], ["SLV"], "DE")).toMatchObject({ 灯: "gray", 态: "查不了" });
  });
});

describe("工商库", () => {
  const 记 = (x: Partial<登记>): 登记 => ({ 库: "测试库", 名: "SLV GmbH", 号: "HRB 1", 存续: true, 国: "DE", 链: "https://reg.example/1", 像: "同", ...x });
  it("挑登记：同 > 近，存续 > 注销", () => {
    expect(挑登记([记({ 像: "近", 号: "a" }), 记({ 存续: false, 号: "b" }), 记({ 号: "c" })])?.号).toBe("c");
  });
  it("英国没配 key 是「不适用」并写明；配了才查", () => {
    expect(国家库("GB", {}).缺key).toBe(true);
    expect(国家库("GB", { COMPANIES_HOUSE_API_KEY: "k" }).库).toBeTypeOf("function");
    expect(国家库("FR", {}).库).toBeTypeOf("function");
    expect(国家库("DE", {}).库).toBeUndefined();
  });
  it("GLEIF 查到同名存续：绿；别国的同名不认", async () => {
    const GLEIF = async () => [记({ 库: "GLEIF", 号: "HRB 9712" }), 记({ 库: "GLEIF", 国: "US", 号: "US-1" })];
    const x = await 查工商(["SLV"], "DE", { GLEIF, env: {} });
    expect(x).toMatchObject({ 灯: "green", 态: "已核" });
    expect(x.事实).toContain("HRB 9712");
    // 法国有官方库：假 fetch 回空；GLEIF 里只有美国的同名 → 不认，算没查到（标黄）
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 })));
    const 美 = await 查工商(["SLV"], "FR", { GLEIF: async () => [记({ 国: "US" })], env: {} });
    expect(美).toMatchObject({ 灯: "yellow", 态: "没查到" });
  });
  it("已注销只在名字一字不差、又没有同名存续时才红", async () => {
    const 注销 = await 查工商(["Ghost Ltd"], "DE", { GLEIF: async () => [记({ 名: "Ghost Ltd", 存续: false })], env: {} });
    expect(注销.灯).toBe("red");
    expect(注销.硬红).toContain("已注销");
    const 近 = await 查工商(["Ghost"], "DE", { GLEIF: async () => [记({ 名: "Ghost Holding Group", 存续: false, 像: "近" })], env: {} });
    expect(近.灯).toBe("yellow");
    const 有存续 = await 查工商(["Ghost"], "DE", { GLEIF: async () => [记({ 名: "Ghost", 存续: false }), 记({ 名: "Ghost", 存续: true, 号: "HRB 2" })], env: {} });
    expect(有存续.灯).not.toBe("red");
  });
  it("没有官方库的国家、GLEIF 也没有：不适用（灰）；英国缺 key 写进事实", async () => {
    expect(await 查工商(["Al Fanar"], "AE", { GLEIF: async () => [], env: {} })).toMatchObject({ 灯: "gray", 态: "不适用" });
    const 英 = await 查工商(["Ansell Lighting"], "GB", { GLEIF: async () => [], env: {} });
    expect(英).toMatchObject({ 灯: "gray", 态: "不适用" });
    expect(英.事实).toContain("还没接上（缺查询 key）");
  });
  it("法国库（假 fetch）：没查到标黄；对面 503 是「查不了」", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 })));
    expect(await 查工商(["Inconnu"], "FR", { GLEIF: async () => [], env: {} })).toMatchObject({ 灯: "yellow", 态: "没查到" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 503 })));
    expect(await 查工商(["Inconnu"], "FR", { GLEIF: async () => [], env: {} })).toMatchObject({ 灯: "gray", 态: "查不了" });
  });
});

describe("第三期：芬兰 / 捷克 / 美国 / 波兰官方库（假 fetch）", () => {
  const 回 = (按网址: (url: string, init?: RequestInit) => unknown, status = 200) =>
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => new Response(JSON.stringify(按网址(String(url), init)), { status })));

  it("哪些国家有库：芬兰、捷克、美国直接查；波兰要对方给了波兰税号", () => {
    expect(国家库("FI", {}).库).toBeTypeOf("function");
    expect(国家库("CZ", {}).库).toBeTypeOf("function");
    expect(国家库("US", {})).toMatchObject({ 名: "美国 SEC EDGAR", 不全: true });
    expect(国家库("PL", {}).库).toBeUndefined();
    expect(国家库("PL", {}).缺税号).toBe(true);
    expect(国家库("PL", {}, "PL 526-025-09-95").库).toBeTypeOf("function");
    expect(国家库("PL", {}, "DE143454214").库).toBeUndefined();
  });

  it("芬兰 PRH：正式名、注销了的看 endDate", async () => {
    回(() => ({
      companies: [
        { businessId: { value: "1761136-9" }, registrationDate: "2002-04-22", names: [{ name: "Helvar Oy Ab", type: "1" }, { name: "Helvar", type: "3" }], addresses: [{ street: "Keilaranta", postOffices: [{ city: "ESBO" }] }] },
        { businessId: { value: "0108851-8" }, endDate: "2002-09-29", tradeRegisterStatus: "4", names: [{ name: "Helvar Oy", type: "1", endDate: "2002-09-29" }] },
      ],
    }));
    const x = await 查工商(["Helvar Oy Ab"], "FI", { GLEIF: async () => [], env: {} });
    expect(x).toMatchObject({ 灯: "green", 态: "已核" });
    expect(x.事实).toBe("芬兰 PRH 企业登记（YTJ）：Helvar Oy Ab，Y-tunnus 1761136-9，存续，2002-04-22 成立，Keilaranta, ESBO");
    expect(x.链接?.[0].url).toBe("https://tietopalvelu.ytj.fi/yritys/1761136-9");
  });

  it("捷克 ARES：POST 按名字查；名字太常见是「查不了」不是「没查到」", async () => {
    回((url, init) => {
      expect(url).toContain("ares.gov.cz");
      expect(JSON.parse(String(init?.body))).toEqual({ obchodniJmeno: "ELKO EP s.r.o.", pocet: 10 });
      return { ekonomickeSubjekty: [{ ico: "25508717", obchodniJmeno: "ELKO EP, s.r.o.", datumVzniku: "1997-11-10", sidlo: { textovaAdresa: "Palackého 493, 76901 Holešov" } }] };
    });
    const x = await 查工商(["ELKO EP s.r.o."], "CZ", { GLEIF: async () => [], env: {} });
    expect(x).toMatchObject({ 灯: "green" });
    expect(x.事实).toContain("IČO 25508717");
    回(() => ({ kod: "CHYBA_VSTUPU", subKod: "VYSTUP_PRILIS_MNOHO_VYSLEDKU" }), 400);
    expect(await 查工商(["Elektro"], "CZ", { GLEIF: async () => [], env: {} })).toMatchObject({ 灯: "gray", 态: "查不了" });
  });

  it("美国 EDGAR：查到是绿；没查到不扣分（多数美国进口商是私人公司，不在 SEC）", async () => {
    回(() => ({ hits: { hits: [{ _id: "1144215", _source: { entity: "Acuity Brands Inc" } }] } }));
    const x = await 查工商(["Acuity Brands"], "US", { GLEIF: async () => [], env: {} });
    expect(x).toMatchObject({ 灯: "green" });
    expect(x.事实).toBe("美国 SEC EDGAR：Acuity Brands Inc，CIK 1144215，在 SEC 有申报记录");
    // 偶发 500：隔一下重试一次
    设美国重试毫秒(0);
    let 次 = 0;
    vi.stubGlobal("fetch", vi.fn(async () => (++次 === 1 ? new Response("", { status: 500 }) : new Response(JSON.stringify({ hits: { hits: [{ _id: "1144215", _source: { entity: "Acuity Brands Inc" } }] } }), { status: 200 }))));
    expect(await 查工商(["Acuity Brands"], "US", { GLEIF: async () => [], env: {} })).toMatchObject({ 灯: "green" });
    expect(次).toBe(2);
    回(() => ({ hits: { hits: [] } }));
    const 没 = await 查工商(["Bright Lamps LLC"], "US", { GLEIF: async () => [], env: {} });
    expect(没).toMatchObject({ 灯: "gray", 态: "不适用" });
    expect(没.事实).toContain("只收上市");
  });

  it("波兰白名单：按税号查一次（两个名字也只请求一次），名字对得上才认；没给税号写明", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ result: { subject: { name: "LUMEN POLSKA SPÓŁKA Z OGRANICZONĄ ODPOWIEDZIALNOŚCIĄ", nip: "5260250995", krs: "0000010681", statusVat: "Czynny", residenceAddress: "ALEJE JEROZOLIMSKIE 160, 02-326 WARSZAWA", registrationLegalDate: "2004-01-01", removalDate: null, accountNumbers: ["58103015080000000503131332"] } } }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    const x = await 查工商(["Lumen Polska Sp. z o.o.", "Lumen Polska"], "PL", { GLEIF: async () => [], env: {}, 税号: "PL5260250995" });
    expect(f).toHaveBeenCalledTimes(1);
    expect(String((f.mock.calls[0] as unknown[])[0])).toMatch(/^https:\/\/wl-api\.mf\.gov\.pl\/api\/search\/nip\/5260250995\?date=\d{4}-\d{2}-\d{2}$/);
    expect(x).toMatchObject({ 灯: "green", 态: "已核" });
    expect(x.事实).toContain("NIP 5260250995，KRS 0000010681");
    expect(x.事实).not.toContain("58103015080000000503131332");
    const 无税号 = await 查工商(["Lumen Polska"], "PL", { GLEIF: async () => [], env: {} });
    expect(无税号).toMatchObject({ 灯: "gray", 态: "不适用" });
    expect(无税号.事实).toContain("要拿税号（NIP）查");
  });
});

describe("税号（VIES）", () => {
  it("认税号：去空格、希腊 GR→EL、非欧盟不认", () => {
    expect(认税号("de 123 456 789")).toEqual({ 国: "DE", 号: "123456789" });
    expect(认税号("GR123456789")).toEqual({ 国: "EL", 号: "123456789" });
    expect(认税号("US123456789")).toBeNull();
  });
  it("有效 / 名字对不上 / 无效 / 对方系统挂了", async () => {
    const 回 = (body: unknown, status = 200) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
    expect(await 查税号(undefined, "SLV")).toMatchObject({ 态: "没提供" });
    回({ isValid: true, name: "---" });
    expect(await 查税号("DE123456789", "SLV")).toMatchObject({ 灯: "green" });
    回({ isValid: true, name: "REXEL FRANCE" });
    expect(await 查税号("FR12345678901", "Rexel France")).toMatchObject({ 灯: "green" });
    回({ isValid: true, name: "TOTALLY OTHER SARL" });
    expect(await 查税号("FR12345678901", "Rexel France")).toMatchObject({ 灯: "yellow" });
    回({ isValid: false, userError: "INVALID" });
    expect(await 查税号("FR12345678901", "Rexel")).toMatchObject({ 灯: "yellow", 态: "已核" });
    回({ isValid: false, userError: "MS_UNAVAILABLE" });
    expect(await 查税号("FR12345678901", "Rexel")).toMatchObject({ 灯: "gray", 态: "查不了" });
    expect(await 查税号("12345", "Rexel")).toMatchObject({ 灯: "yellow" });
  });
});

describe("线索（从档案和用户那句话里认）", () => {
  it("邮箱、+ 开头的电话、欧盟税号、网址（邮箱里的域名不算官网）", () => {
    const x = 认线索("帮我查 John@slv-lighting.co 这个客户，电话 +971 50 123 4567，税号 DE 123456789，网站 www.slv.com/de");
    expect(x.邮箱).toEqual(["john@slv-lighting.co"]);
    expect(x.电话).toEqual(["+971 50 123 4567"]);
    expect(x.税号).toBe("DE123456789");
    expect(x.官网).toBe("slv.com");
    expect(认线索("找 buyer@gmail.com 的公司").官网).toBeUndefined();
    expect(认线索("订单号 2026101812345").电话).toEqual([]);
  });
  it("合并：去重，前面的优先", () => {
    expect(合并线索({ 邮箱: ["a@x.com"], 国家: "DE" }, { 邮箱: ["a@x.com", "b@x.com"], 国家: "FR", 官网: "x.com" })).toEqual({ 邮箱: ["a@x.com", "b@x.com"], 电话: [], 官网: "x.com", 国家: "DE" });
  });
});

describe("域名项、核验（假依赖）", () => {
  it("域名年龄分档：两年以上绿、90 天以下带「新域名」", () => {
    expect(域名项("a.com", { 有: true, 日期: 前(3000), 依据: "RDAP", 下限: false, 链接: "x" }).灯).toBe("green");
    expect(域名项("a.com", { 有: true, 日期: 前(200), 依据: "Wayback", 下限: true, 链接: "x" })).toMatchObject({ 灯: "yellow" });
    expect(域名项("a.com", { 有: true, 日期: 前(20), 依据: "RDAP", 下限: false, 链接: "x" }).新域名).toBe(true);
    expect(域名项(undefined, null)).toMatchObject({ 灯: "yellow", 态: "没查到" });
    expect(域名项("a.com", { 有: false, 查不了: true })).toMatchObject({ 灯: "gray", 态: "查不了" });
  });
  it("几项并行、按固定顺序；一项挂了只是那一项「查不了」；同一个域名只查一次年龄", async () => {
    const 查年龄 = vi.fn(年龄(3000));
    const r = await 核验(
      { 公司: "SLV GmbH", 域名: "www.slv.com", 邮箱: ["a@slv.com"], 电话: ["+49 2405 4170"], 国家: "DE" },
      {
        查年龄,
        查MX: 有MX,
        查官网: async () => {
          throw new Error("炸了");
        },
        取名单: async () => [{ 名: "OFAC", 更新于: "2026-10-18T00:00:00Z", 条: [] }],
        查工商: async () => ({ key: "registry", 灯: "green", 态: "已核", 事实: "GLEIF：SLV GmbH" }),
        查税号: async () => ({ key: "vat", 灯: "gray", 态: "没提供", 事实: "没提供税号，未查" }),
      },
    );
    expect(r.项.map((x) => x.key)).toEqual(["registry", "vat", "domain", "site", "email", "phone", "sanctions"]);
    expect(r.项.find((x) => x.key === "site")).toMatchObject({ 灯: "gray", 态: "查不了" });
    expect(r.项.find((x) => x.key === "domain")?.灯).toBe("green");
    expect(r.项.find((x) => x.key === "email")?.灯).toBe("green");
    expect(r.名单更新于).toBe("2026-10-18T00:00:00Z");
    expect(查年龄).toHaveBeenCalledTimes(1);
  });
});

describe("总灯和信息少（代码定，不经模型）", () => {
  const 项 = (key: 核验项["key"], 灯: 核验项["灯"], 态: 核验项["态"] = "已核", 多: Partial<核验项> = {}): 核验项 => ({ key, 灯, 态, 事实: `${key}`, ...多 });
  it("硬红直接红；新域名 + 足迹全未搜到也红", () => {
    expect(定总灯([项("domain", "green"), 项("sanctions", "red", "已核", { 硬红: "制裁名单疑似命中" })]).总灯).toBe("red");
    expect(定总灯([项("domain", "yellow", "已核", { 新域名: true }), 项("footprint", "yellow", "没查到")]).总灯).toBe("red");
    expect(定总灯([项("domain", "yellow", "已核", { 新域名: true }), 项("footprint", "green")]).总灯).toBe("yellow");
  });
  it("有黄、或者能核的不到一半：黄；都核得上：绿。没提供 / 不适用不算能核的", () => {
    expect(定总灯([项("domain", "green"), 项("email", "yellow")]).总字).toBe("基本可信，有 1 处要留意");
    // 3 处以上不再说「基本可信」（10-18 bench：假公司 4 处黄）
    expect(定总灯([项("domain", "yellow"), 项("site", "yellow"), 项("email", "yellow"), 项("phone", "yellow"), 项("sanctions", "green")]).总字).toBe("疑点较多，有 4 处要留意，先核实再谈");
    expect(定总灯([项("domain", "green"), 项("registry", "gray", "查不了"), 项("site", "gray", "查不了")]).总灯).toBe("yellow");
    expect(定总灯([项("domain", "green"), 项("site", "green"), 项("phone", "gray", "没提供"), 项("vat", "gray", "不适用")]).总灯).toBe("green");
  });
  it("合成：九项按固定顺序，缺的补默认那一行", () => {
    const v = 合成真实性(null, 项("footprint", "green"));
    expect(v.项.map((x) => x.key)).toEqual(["registry", "vat", "domain", "site", "email", "phone", "ip", "sanctions", "footprint"]);
    expect(v.项.find((x) => x.key === "ip")?.事实).toBe("没贴询盘邮件原文，未查（背调模式里点「粘贴询盘邮件」可以带上）");
    expect(v.总灯).toBe("yellow");
  });

  function 跑(事件: 研究事件[]) {
    return 事件.reduce(归约, 初始状态({ name: "Ghost Trading" }));
  }
  it("没跑完不出；查得少（来源不到 3 个独立网站、工商没查到、社媒全无）出横幅并列出缺的", () => {
    const 足迹 = 项("footprint", "yellow", "没查到");
    const v = 合成真实性([项("registry", "yellow", "没查到"), 项("domain", "yellow", "没查到")], 足迹);
    const 事件: 研究事件[] = [{ type: "verify", 真实性: v }];
    expect(信息少(跑(事件))).toBeNull();
    const s = 跑([...事件, { type: "done", charge: 1, 不完整: false }]);
    const 少 = 信息少(s);
    expect(少?.缺).toEqual(expect.arrayContaining(["没有工商登记", "没搜到 Facebook 主页", "没找到官网", "没有独立来源"]));
    expect(少?.文字).toMatch(/^网上能查到的很少：.*建议先要营业执照、视频验厂，或走信用证 \/ 小额试单。$/);
  });
  it("独立来源按主域名算，不算它自己的官网", () => {
    const s = 跑([
      { type: "field", key: "site", value: "ghost.com", source: "https://ghost.com/about" },
      { type: "tag", tone: "signal", text: "a", source: "https://news.example.com/1" },
      { type: "tag", tone: "signal", text: "b", source: "https://www.news.example.com/2" },
      { type: "tag", tone: "signal", text: "c", source: "https://other.org/x" },
    ]);
    expect(独立来源数(s)).toBe(2);
  });
  it("状态收 verify / verify-note / import；报告文本带真实性块和进口记录", () => {
    const v = 合成真实性([项("sanctions", "green", "已核", { 事实: "美国 OFAC：未命中" })], 项("footprint", "green", "已核", { 事实: "LinkedIn 公司主页：有", 链接: [{ title: "SLV | LinkedIn", url: "https://linkedin.com/company/slv" }] }));
    const s = 跑([
      { type: "verify", 真实性: v },
      { type: "verify-note", text: "名单没命中，社媒有主页。" },
      { type: "import", 有: true, 摘要: "2025 年从中国进口灯具 12 柜", source: "https://trade.example/slv" },
      { type: "done", charge: 1, 不完整: false },
    ]);
    expect(s.真实性?.总结).toBe("名单没命中，社媒有主页。");
    expect(s.进口).toEqual({ 有: true, 摘要: "2025 年从中国进口灯具 12 柜", source: "https://trade.example/slv" });
    expect(s.sources.some((x) => x.url === "https://trade.example/slv")).toBe(true);
    // 没有来源的进口记录不收
    expect(跑([{ type: "import", 有: true, 摘要: "瞎编的" }]).进口).toEqual({ 有: false });
    const 文 = 报告文本(s);
    expect(文).toContain("【真实性】");
    expect(文).toContain("程序直查，不经模型");
    expect(文).toContain("美国 OFAC：未命中");
    expect(文).toContain("进口记录");
  });
});
