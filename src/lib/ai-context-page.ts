/**
 * 当前页是什么，一句话。给全局 AI 面板当上下文用。
 *
 * **必须看得见、点得掉**：面板顶上把这句话摆出来，旁边一个 ×。
 * 用户得知道 AI 看到了什么——一个隐形的上下文，答歪了没人能解释为什么。
 *
 * 纯函数、不引 next：路由是字符串，测得起来。
 * 只认一级路由；客户详情页的名字由调用方补（那要查库，不是路径能知道的）。
 */
export type 页面上下文 = {
  /** 面板顶上那一行，给人看 */
  标签: string;
  /** 塞进提问里的那句，给模型看。空串 = 这一页没有值得带的上下文 */
  提示: string;
};

const 一级: Record<string, { 名: string; 提示: string }> = {
  "/dashboard": { 名: "首页", 提示: "" },
  "/overview": { 名: "数据", 提示: "用户正在看数据概览页" },
  "/reports": { 名: "数据 · 复盘", 提示: "用户正在看签约复盘页" },
  "/leads": { 名: "线索", 提示: "用户正在看线索列表" },
  "/customers": { 名: "客户", 提示: "用户正在看客户列表" },
  "/channels": { 名: "渠道", 提示: "用户正在看渠道列表" },
  "/contacts": { 名: "联系人", 提示: "用户正在看联系人列表" },
  "/opportunities": { 名: "商机", 提示: "用户正在看商机列表" },
  "/opportunities/pipeline": { 名: "商机 · 管道", 提示: "用户正在看商机管道看板" },
  "/follow-ups": { 名: "跟进记录", 提示: "用户正在看跟进记录列表" },
  "/follow-ups/plans": { 名: "跟进计划", 提示: "用户正在看跟进计划列表" },
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
    return { 标签: `${命中.名}${尾}`, 提示: `${命中.提示 || `用户正在看${命中.名}`}${尾}。回答时把这个范围考虑进去。` };
  }
  // 客户详情 /customers/xxx
  const m = /^\/customers\/([^/]+)$/.exec(pathname);
  if (m && 详情名) return { 标签: `客户 · ${详情名}`, 提示: `用户正在看${详情名}的记录页。「他」「这位」指的就是${详情名}。` };
  return null;
}
