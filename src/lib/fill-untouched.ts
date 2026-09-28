/**
 * AI 预填表单：**只填人没动过的格子**。
 *
 * 通则（2026-09-18 拍板，见「个人资料名字不许被同步覆盖」那条）：
 * 凡是系统帮你填的字段，一旦人动过手，就不能再被自动逻辑改回去。
 *
 * 2026-09-28 交互审查 M6：记录页「AI 解析填表」要跑十来秒，这期间表单每一格都能改，
 * 结果回来把类型、状态、标题、内容、时间整个盖掉，人刚补的字就没了；「重新解析」也一样。
 * 现在按 antd 的 isFieldTouched 分：没动过的照填，动过的留着，并在结果那一行说一句「标题你改过，没动」。
 *
 * 纯函数：不认识 antd，只认「这一格动过没有」。
 */
export function 只填没动过的<T extends Record<string, unknown>>(
  候选: T,
  动过: (name: keyof T & string) => boolean,
): { 填: Partial<T>; 跳过: (keyof T & string)[] } {
  const 填: Partial<T> = {};
  const 跳过: (keyof T & string)[] = [];
  for (const k of Object.keys(候选) as (keyof T & string)[]) {
    if (!动过(k)) {
      填[k] = 候选[k];
      continue;
    }
    // AI 这一格本来就没给东西：没什么可让的，也就不必说「没动」
    const v = 候选[k];
    if (v !== undefined && v !== null && v !== "") 跳过.push(k);
  }
  return { 填, 跳过 };
}

/** 「标题、内容你改过，没动」。没有跳过的就是 null */
export function 跳过说明(跳过: string[], 名: Record<string, string>): string | null {
  if (!跳过.length) return null;
  return `${跳过.map((k) => 名[k] ?? k).join("、")}你改过，没动`;
}
