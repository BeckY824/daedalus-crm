/**
 * 列表页多选的两条规矩（components/DataList.tsx 用）。抽成纯函数，单测钉着。
 *
 * 2026-09-28 交互审查 S4：勾了 3 个人，再换个筛选或搜一下，工具条上仍写「已选 3 条」，
 * 可表里一个都看不到；这时点批量删除，删的是人眼前没有的行，而删除连带跟进和签约、不可恢复。
 */

/**
 * 行一变（筛选、搜索、翻页），勾选里不在当前行上的那些就清掉。
 *
 * 为什么是「清掉」而不是「已选 3 条（其中 2 条不在当前筛选里）」：
 * 批量动作的对象必须是人眼前的东西。看不见的勾选留着，只会在下一次批量时伤人。
 *
 * 没有变化时原样返回同一个数组——调用方拿它做 setState，返回新数组就会白渲染一轮。
 */
export function 只留当前行(选中: string[], 行ids: readonly string[]): string[] {
  if (选中.length === 0) return 选中;
  const 在 = new Set(行ids);
  const 留 = 选中.filter((id) => 在.has(id));
  return 留.length === 选中.length ? 选中 : 留;
}

/**
 * 批量删除确认框的标题：写出是谁，不只写几个。
 *
 *   1 位   → 「确认删除客户 何静？」
 *   ≤最多  → 「确认删除 何静、孙婉、张三 这 3 位客户？」
 *   >最多  → 「确认删除 何静、孙婉、张三 等 5 位客户？」
 *
 * 叫法跟着业务配置走（客户 / 学员 / 买家），调用方传进来。
 * 名字比人数少（行上没名字的）也按人数说，名字只列拿得到的。
 */
export function 删除确认标题(名字: string[], 人数: number, 叫法: string, 最多 = 3): string {
  const 有名 = 名字.filter(Boolean);
  if (有名.length === 0) return `确认删除选中的 ${人数} 位${叫法}？`;
  if (人数 === 1) return `确认删除${叫法} ${有名[0]}？`;
  const 列 = 有名.slice(0, 最多).join("、");
  return 人数 > Math.min(有名.length, 最多) ? `确认删除 ${列} 等 ${人数} 位${叫法}？` : `确认删除 ${列} 这 ${人数} 位${叫法}？`;
}

/**
 * 刚勾上的那一列要横滚到哪儿（S5）。返回新的 scrollLeft；已经看得见就返回 null，不动。
 *
 * 看得见的那一段不是整个框宽：左边让开固定的勾选框和名字列，右边让开固定的操作列。
 * 原来只让了右边——列是露出来了，可左边固定之前名字列会被滚走；
 * 固定之后不让左边，列的开头又会压在名字列底下。
 *
 * 都用 DOM 的原始量（像素）：列左 = th.offsetLeft，都相对表格本身。
 */
export function 露出这一列(x: { 滚到: number; 框宽: number; 列左: number; 列宽: number; 左固定: number; 右固定: number }): number | null {
  const 看得见左 = x.滚到 + x.左固定;
  const 看得见右 = x.滚到 + x.框宽 - x.右固定;
  const 列右 = x.列左 + x.列宽;
  // 右边露不全：挪到右沿刚好露出来
  if (列右 > 看得见右) return Math.max(0, 列右 - x.框宽 + x.右固定);
  // 左边压在固定列底下：挪到左沿刚好贴着名字列
  if (x.列左 < 看得见左) return Math.max(0, x.列左 - x.左固定);
  return null;
}

/**
 * 列设置：这台机器上存的那份 → 现在显示哪几列（2026-10-04 上线前第 2 期 2b）。
 *
 * 存的是显示的列键；藏起来的**默认列**记成 `-键`。原来只存显示的那些，读的时候把「存的里没有、默认显示」的列
 * 当成「存完之后新加的列」补回来——于是默认显示的列一勾掉就被补回来，怎么也藏不住（e2e/column-hide 抓到）。
 * 老格式（没有 `-键`）照旧读：存完之后新加的、默认显示的列照样补上。
 */
export function 算可见列(可选: { 键: string; 默认显示: boolean }[], 存的: readonly string[] | null): string[] {
  if (!存的) return 可选.filter((c) => c.默认显示).map((c) => c.键);
  const 藏了 = new Set(存的.filter((k) => k.startsWith("-")).map((k) => k.slice(1)));
  const 显示 = 存的.filter((k) => !k.startsWith("-"));
  const 提过 = new Set([...显示, ...藏了]);
  return [...显示, ...可选.filter((c) => !提过.has(c.键) && c.默认显示).map((c) => c.键)];
}

/** 勾 / 取消一列之后要存的那份：显示的列键 + 藏起来的 `-键` */
export function 切换后存(可见: readonly string[], 存的: readonly string[] | null, k: string, 显示: boolean): string[] {
  const 藏了 = (存的 ?? []).filter((x) => x.startsWith("-") && x !== `-${k}`);
  return 显示 ? [...可见.filter((x) => x !== k), k, ...藏了] : [...可见.filter((x) => x !== k), ...藏了, `-${k}`];
}
