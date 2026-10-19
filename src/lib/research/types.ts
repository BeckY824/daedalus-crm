/**
 * AI 联网背调（2026-10-16）：桌面端和服务器两头共用的形状。
 *
 * 分工：
 *   桌面端（本机 Next 服务）  跑 6 步编排（lib/research/run.ts），每一步让模型在上限内调 web_search / read_page
 *   我们的服务器              /api/gateway/v1/research/{start,search,read,finish}：扣次数、真去搜、真去读网页
 *
 * 搜索 Key 只在服务器上（中转站自带搜索：Claude / GPT，10-16 用户定）；桌面端拿设备令牌来，和模型网关同一套鉴权。
 * 开发和测试一律走模拟（lib/research/mock.ts），不花钱。
 */

export const 阶段表 = [
  { id: "identify", label: "认准公司" },
  { id: "basics", label: "基本面" },
  { id: "fit", label: "和我们的相关性" },
  { id: "signals", label: "近期信号" },
  { id: "risks", label: "风险排查" },
  { id: "approach", label: "切入建议" },
] as const;

export type 阶段号 = (typeof 阶段表)[number]["id"];

/** 一次搜索回来的一条 */
export type 搜索结果 = {
  title: string;
  url: string;
  /** 这条和查询相关的那一两句（搜索服务给的摘要或引用原文），可以为空 */
  snippet: string;
  /** 发布 / 更新时间，搜索服务给就带上，原样字符串 */
  published?: string;
};

/** 读一页回来的正文（已去掉标签，截断过） */
export type 读页结果 = { url: string; title: string; text: string; 截断了: boolean };

/**
 * 一次背调的硬上限（默认值）。搜索次数可以在服务器上调（RESEARCH_SEARCH_LIMIT，price.ts），开始时随回应告诉桌面端；
 * 服务器按同一份数再卡一遍（客户端可以被改，服务器不行）
 */
export const 背调上限 = { 搜索: 8, 读页: 10 } as const;

/**
 * 近期信号那一步程序自己发的 Facebook 定向搜索（lib/research/verify/social.ts 社媒查询；LinkedIn 搜索不收录，10-18 去掉）：
 * 不占模型的搜索次数，服务器的次数闸多放这么几次（10-18）
 */
export const 社媒搜索次数 = 1;

/**
 * 只有人名 + 电话、没有公司（lib/research/person.ts）：先搜号码的国际写法、本国写法、不带开头 0 的写法和「人名 + 国家」，
 * 最多这么几次。服务器的次数闸也多放这么几次（找完公司接着背调用的是同一个 runId）
 */
export const 找公司搜索次数 = 4;

/* 扣几次、花多少的规矩在 price.ts（服务器按配置算，桌面端开跑前问 /research/price 拿数） */

/* ---------- 网关接口（/api/gateway/v1/research/*）的请求和回应 ---------- */

/** 开跑前问价：一次扣几次背调次数（1）、还剩几次背调（和问答的 AI 次数分开；测试账号 不限） */
export type 价目回应 = { 扣次: number; 还剩: number; 不限?: true };

/** 这次背调到现在估计花了多少钱、上限多少（元）。搜索 / 读页的回应里带着，桌面端到了上限就停手 */
export type 花费 = { 已花元: number; 上限元: number };

/**
 * runId 和 X-Question-Id 同一个规矩：1–64 位 [A-Za-z0-9_-]。
 * 走我们的模型：老字段，服务器不再看——10-16 起背调的搜索和分析一律走我们的服务器、一律照价扣（price.ts）
 */
export type 开始请求 = { runId: string; 走我们的模型?: boolean };
export type 开始回应 =
  | {
      ok: true;
      扣了: number;
      /** 背调次数还剩几次 */
      还剩: number;
      /** 最后打分 + 写报告用哪个模型（服务器定，固定 gpt-5.5） */
      模型?: string;
      /** 每一步挑工具、写摘要用哪个模型（服务器定，可以是便宜的 mini） */
      摘要模型?: string;
      /** 这次最多搜几次（服务器配置 RESEARCH_SEARCH_LIMIT） */
      搜索上限?: number;
    }
  | { ok: false; error: string };

export type 搜索请求 = { runId: string; query: string };
export type 搜索回应 = { results: 搜索结果[]; 花费?: 花费 };

export type 读页请求 = { runId: string; url: string };
export type 读页回应 = 读页结果 & { 花费?: 花费 };

/**
 * 收尾。ok = 桌面端这边 6 步都跑完了（只记账用）；取消 = 用户自己停的（点了停、关了页面），不退。
 * **退不退服务器自己判断**（credits.ts 的 收尾背调）：最后一步交没交出去、我们这边失败过没有，都是服务器自己记的
 */
export type 收尾请求 = { runId: string; ok: boolean; 取消?: boolean; searches?: number; pages?: number };
export type 收尾回应 = { ok: true; 退了: number; 还剩: number };

/* ---------- 背调过程的事件流（本机 /api/ai/stream → 浏览器） ----------
 *
 * 每个看得见的变化都对应一条事件：阶段开始 / 结束、一次搜索、一格档案填上、分数出来……
 * 浏览器按 lib/research/state.ts 的 归约 一条条叠成 背调状态；最后那份状态就是报告本身，
 * 存进对话历史、存进客户档案用的都是它。所以界面上看到的和存下来的不会对不上。
 */

export type 来源 = { title: string; url: string };

/** 公司卡上的那几格。值都是一句短话，查不到就不出现 */
export const 字段表 = [
  { key: "country", label: "国家 / 城市" },
  { key: "founded", label: "成立" },
  { key: "size", label: "规模" },
  { key: "business", label: "主营" },
  { key: "buyerType", label: "买家类型" },
  { key: "site", label: "官网" },
  { key: "contact", label: "公开联系方式" },
] as const;
export type 字段键 = (typeof 字段表)[number]["key"];

export type 工具事件 = {
  type: "tool";
  /** person = 只有人名 + 电话时「找公司」那几次搜索（不属于 6 步里的哪一步） */
  stage: 阶段号 | "person";
  id: string;
  kind: "search" | "read";
  label: string;
  status: "running" | "done" | "error";
  /** 做完的一句：「9 条结果」「1 页 · 2.4k 字」「读不了：…」 */
  result?: string;
  ms?: number;
  sources?: 来源[];
};

export type 像的老客户 = { id: string; name: string; 档: "high" | "mid" | "low"; 像在哪: string };

export type 研究事件 =
  | { type: "stage"; stage: 阶段号; status: "running" | "done" | "error"; /** 做完的一句结论，折叠后那一行显示它 */ summary?: string }
  | { type: "thought"; stage: 阶段号; text: string }
  | 工具事件
  | { type: "field"; key: 字段键; value: string; source?: string }
  | { type: "score"; 评分: import("./score").评分结果 }
  | { type: "tag"; tone: "signal" | "risk"; level?: "low" | "mid" | "high"; text: string; source?: string; /** 风险那条：怎么应对（10-18 A+D 结构：风险 | 证据 | 应对） */ 应对?: string }
  | { type: "similar"; items: 像的老客户[]; /** CRM 里拿来比的老客户有几位；0 = 还没有成交 / 在谈的客户 */ 比了: number }
  | { type: "approach"; points: string[] }
  /** 真实性那一块（灯是代码定的，见 verify/rules.ts）；切入建议那一步写完后再来一条 verify-note 补上模型那句话 */
  | { type: "verify"; 真实性: import("./verify/types").真实性 }
  | { type: "verify-note"; text: string }
  /** 公开的进口记录（10-18 用户定：不接付费源）。有 = 摘要 + 一条核得上的来源；没有就是「未查到公开进口记录」 */
  | { type: "import"; 有: boolean; 摘要?: string; source?: string; /** 来源的标题（HMRC 名录那条不在材料里，没有标题） */ 来源名?: string }
  /** 风险那一步必查的四项（10-18 对比免费产品第一点）：每项一句结论；查不到的不带来源 */
  | { type: "checks"; 项: 必查项[] }
  /** 它在卖的具体型号（fit 那一步；型号名必须在来源原文里出现过） */
  | { type: "models"; items: 在卖型号[] }
  /** 公开的业务联系人（basics 那一步；姓名、电话、邮箱都必须在来源原文里出现过，私人社交不算） */
  | { type: "contacts"; items: 联系人[] }
  /** 切入那一步：对方型号和我们的产品怎么比；英文开发信 */
  | { type: "compare"; items: 型号对比[] }
  | { type: "email"; 主题: string; 正文: string }
  /** 10-18 报告结构（盲评 A + D）：开头那段「它是哪类客户、开发前先弄清什么」、关键发现（机会 / 障碍）、按我们品类的产品匹配、认证提醒 */
  | { type: "profile"; 类型: string; 先验证: string[] }
  | { type: "findings"; items: 关键发现[] }
  | { type: "match"; items: 产品匹配[] }
  | { type: "certs"; 提醒: string[] }
  | { type: "usage"; searches: number; pages: number }
  /** 只有人名 + 电话（person.ts）：开头先来一条，号码是本机判的（哪国、手机还是固话） */
  | { type: "person"; 名?: string; 号: import("./person").号码信息 }
  /** 找完了：认出的候选公司（程序核过来源）、号码 / 名字在哪些公开页面上出现过、没候选时简版的建议 */
  | { type: "person-found"; 候选: import("./person").候选公司[]; 出现: import("./person").出现; 建议?: string[]; 选了?: string }
  | {
      type: "done";
      charge: number;
      /** 某一步没跑完，或碰到单次成本上限停手：用已有材料出的报告。搜索 / 读页次数用满不算（那是预算） */
      不完整: boolean;
      /** 服务器判定这次没跑完是我们这边的原因，扣的那 1 次退回了 */
      退了?: boolean;
    };

/** 风险必查四项（10-18 对比免费产品第一点：豆包 / ChatGPT 都查了母公司、财务、是不是同行、在不在目标市场，我们没查） */
export const 必查表 = [
  { key: "母公司", label: "母公司 / 股东", 问: "母公司 / 大股东是谁；集团自己有没有工厂、是不是在重组 / 出售" },
  { key: "财务", label: "近两年财务", 问: "近两年营收、盈亏、再融资 / 债务重组、评级、裁员" },
  { key: "同行", label: "是不是同行", 问: "自己生产同类产品吗（同行 = 竞争对手，不是买家）" },
  { key: "市场", label: "目标市场", 问: "在不在我们的目标市场做生意；有没有撤出 / 收缩" },
] as const;
export type 必查键 = (typeof 必查表)[number]["key"];
export type 必查项 = {
  key: 必查键;
  结论: string;
  /** none = 查了、没问题 */
  级别: "none" | "low" | "mid" | "high";
  /** 查不到就没有来源 */
  source?: string;
  /** 只有「同行」那一项有：是 / 部分 / 否 / 查不到，评分封顶用（score.ts） */
  是?: import("./score").同行判断;
  /** 有级别的那几项：怎么应对，一句话 */
  应对?: string;
};
export type 在卖型号 = { 型号: string; 是什么?: string; source: string };
export type 联系人 = { 岗位?: string; 姓名?: string; 电话?: string; 邮箱?: string; source: string };
export type 型号对比 = { 对方: string; 我们: string; 怎么比: string };
/** 关键发现：一条和开发策略有关的事实（带来源），对我们是机会还是障碍 */
export type 关键发现 = { 事实: string; 机会?: string; 障碍?: string; source: string };
/** 产品匹配：按我们业务简介里的品类一行一行比——匹配度、它官网上原样写的系列名、开发优先级、要准备什么 */
export type 产品匹配 = { 品类: string; 匹配: "高" | "中" | "低"; 开发: "优先" | "选择性" | "谨慎"; 系列: string[]; 依据?: string; 准备?: string; source?: string };
