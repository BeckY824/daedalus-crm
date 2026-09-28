/**
 * 当前列表页上正列着的名字。
 *
 * 全局 AI 面板要知道的不只是「人在哪一页」，还有「这一页上有什么」。
 * 2026-09-19 那一问：人站在渠道页，表里就一行「明杰哥」，问他的电话——
 * 模型跑去客户库搜、搜不到、再让人「跟我说一声我按渠道那边查」。
 * 路由只能告诉它这一页是渠道；名字在表里明摆着，我们一个字都没带过去。
 *
 * 所以 DataList 渲染时把这一页的名字登记在这儿（每个列表页都走它，不用每页手写），
 * 卸载时清空；AiDock 订阅它。**只登记名字，不登记别的字段**——上下文是按 token 付钱的，
 * 而名字已经足够把「这个名字在哪张表」这件事从模型手里拿走。
 *
 * 记录页那种「这一页说的是谁」也登记在这儿：路径里只有 id，看不出人名。
 *
 * 纯模块，不引 next：AiDock 用 useSyncExternalStore 接，测试可以直接调。
 */
const 上限 = 50;
let 名字: string[] = [];
let 详情名: string | null = null;
const 订阅者 = new Set<() => void>();

function 广播() {
  for (const f of 订阅者) f();
}

export function 登记页面行(names: readonly string[]) {
  const 去重 = [...new Set(names.map((n) => n.trim()).filter(Boolean))].slice(0, 上限);
  // 内容没变就不广播，免得每次 router.refresh 都把面板重渲一遍
  if (去重.length === 名字.length && 去重.every((n, i) => n === 名字[i])) return;
  名字 = 去重;
  广播();
}

/** 记录页挂上时登记这条记录的名字，卸载时登记 null */
export function 登记详情名(名: string | null) {
  if (名 === 详情名) return;
  详情名 = 名;
  广播();
}

export function 读详情名(): string | null {
  return 详情名;
}

export function 读页面行(): string[] {
  return 名字;
}

export function 订阅页面行(f: () => void): () => void {
  订阅者.add(f);
  return () => {
    订阅者.delete(f);
  };
}
