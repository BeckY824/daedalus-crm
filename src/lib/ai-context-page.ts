/**
 * 当前页是什么，一句话。给全局 AI 面板当上下文用。
 *
 * **必须看得见、点得掉**：面板顶上把这句话摆出来，旁边一个 ×。
 * 用户得知道 AI 看到了什么——一个隐形的上下文，答歪了没人能解释为什么。
 *
 * 纯函数、不引 next：路由是字符串，测得起来。
 * 只认一级路由；客户详情页的名字由调用方补（那要查库，不是路径能知道的）。
 *
 * ---
 *
 * **每一页还要说清「这一页的数据用哪个工具查」。** 2026-09-19 报上来的：
 * 在线索页问「Steven 是哪家公司的？」，模型连着四次 `search_customers()` 空参数，
 * 一条都没查着就中断了——Steven 是那条线索的联系人，在 Lead 表里，
 * 而 `search_customers` 翻的是 Customer 表，两张表。
 *
 * `list_leads` 的工具说明里其实**已经**写着「线索和客户是两张表，别用 search_customers 找线索」，
 * 没用：十一个工具的说明一起摆在模型面前，它按名字的字面意思挑，「搜客户」看着最像「找人」。
 * 小模型在这一步上不可靠，所以不能只靠工具自己的说明——
 * 人正站在哪一页是我们**确定知道**的信息，把它兑换成一句指名道姓的话，
 * 比让模型每次重新推理一遍稳得多（和 agent/intents.ts 是同一个思路）。
 */
export type 页面上下文 = {
  /** 这一页叫什么，不带筛选。落库时当对话标题的前缀用 */
  名: string;
  /** 面板顶上那一行，给人看 */
  标签: string;
  /** 塞进提问里的那句，给模型看。空串 = 这一页没有值得带的上下文 */
  提示: string;
};

type 页 = {
  名: string;
  提示: string;
  /**
   * 这一页的数据该用哪个工具查。
   * **加一页就必须填它**，否则那一页的面板会退回「凭工具名字猜」——
   * 不报错，只是像线索页那样连查四次空的。tests/ai-context-page.test.ts 会对一遍。
   */
  工具?: string;
  /** 光给工具名不够时补一句：这一页的东西在库里到底是什么 */
  提醒?: string;
};

const 一级: Record<string, 页> = {
  "/dashboard": { 名: "首页", 提示: "" },
  "/overview": { 名: "数据", 提示: "用户正在看数据概览页", 工具: "query_metric" },
  "/reports": { 名: "数据 · 复盘", 提示: "用户正在看签约复盘页", 工具: "query_metric 或 list_contracts" },
  "/leads": {
    名: "线索",
    提示: "用户正在看线索列表",
    工具: "list_leads",
    提醒: "线索和客户是**两张不同的表**。这一页上出现的名字（含「联系人」那一列）都在线索表里，search_customers 一条也查不到。",
  },
  "/customers": { 名: "客户", 提示: "用户正在看客户列表", 工具: "search_customers" },
  "/channels": { 名: "渠道", 提示: "用户正在看渠道列表", 工具: "list_channels" },
  "/contacts": {
    名: "联系人",
    提示: "用户正在看联系人列表",
    工具: "get_customer",
    提醒: "联系人没有单独的查询工具，它们挂在客户下面——先 search_customers 找到那位客户，再 get_customer 看他的联系人。",
  },
  "/opportunities": { 名: "商机", 提示: "用户正在看商机列表", 工具: "list_opportunities" },
  "/opportunities/pipeline": { 名: "商机 · 管道", 提示: "用户正在看商机管道看板", 工具: "list_opportunities" },
  "/follow-ups": { 名: "跟进记录", 提示: "用户正在看跟进记录列表", 工具: "search_followups" },
  "/follow-ups/plans": { 名: "跟进计划", 提示: "用户正在看跟进计划列表", 工具: "get_my_plans" },
  "/settings": { 名: "设置", 提示: "" },
  "/billing": { 名: "用量", 提示: "" },
};

/** 列表页上值得带过去的筛选条件。key 是地址栏参数名，值是给人看的说法 */
const 筛选说法: Record<string, string> = {
  status: "状态",
  followStatus: "跟进状态",
  decisionStatus: "决策状态",
  stage: "阶段",
  owner: "负责人",
  ownerName: "负责人",
  channel: "渠道",
  source: "来源",
  keyword: "关键词",
  q: "关键词",
  createdWithin: "建档时间",
};

/** 「这一页的数据用 X 查」那一句。没登记工具的页面（设置、用量）不说 */
function 指路(p: 页): string {
  if (!p.工具) return "";
  return `\n  这一页的数据用 **${p.工具}** 查。${p.提醒 ?? ""}问到这一页上的名字、记录、数字，先用它，别挑别的工具试。`;
}

/**
 * @param pathname 形如 /customers 或 /customers/abc123
 * @param params   地址栏参数
 * @param 详情名   详情页上这条记录叫什么（客户姓名等）。列表页传 null
 */
export function 认页面(pathname: string, params: URLSearchParams | null, 详情名?: string | null): 页面上下文 | null {
  const 命中 = 一级[pathname];
  if (命中) {
    const 条件: string[] = [];
    for (const [k, 说法] of Object.entries(筛选说法)) {
      const v = params?.get(k);
      if (v) 条件.push(`${说法} ${v}`);
    }
    if (!命中.提示 && 条件.length === 0) return null; // 首页、设置这些：没什么可带的
    const 尾 = 条件.length ? `，筛了${条件.join("、")}` : "";
    return {
      名: 命中.名,
      标签: `${命中.名}${尾}`,
      提示: `${命中.提示 || `用户正在看${命中.名}`}${尾}。回答时把这个范围考虑进去。${指路(命中)}`,
    };
  }
  // 客户详情 /customers/xxx
  const m = /^\/customers\/([^/]+)$/.exec(pathname);
  if (m && 详情名)
    return {
      名: `客户 · ${详情名}`,
      标签: `客户 · ${详情名}`,
      提示:
        `用户正在看${详情名}的记录页。「他」「这位」指的就是${详情名}。` +
        `\n  这一页的数据用 **get_customer** 查（参数 name="${详情名}"）。问到这位的情况先用它。`,
    };
  return null;
}
