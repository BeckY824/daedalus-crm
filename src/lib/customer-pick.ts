/**
 * 「挑一位客户」下拉里每一项怎么写（2026-10-04 J-016）。
 *
 * 原来只给姓名：两位都叫「王强」时下拉里是两行一模一样的「王强」，添加联系人挑错了人也看不出来，
 * 联系人就挂到了别人名下。重名的才补上公司（档案字段 1）和手机尾号；不重名的照旧只写名字，不添乱。
 * 尾号只取 4 位：共享试用区的打码（maskPhone）本来就露后 4 位，这里不多露。
 * 不依赖数据库，客户端组件也能引。
 */
export type 候选客户源 = { id: string; name: string; school?: string | null; phone?: string | null };

export function 客户候选(rows: 候选客户源[]): { id: string; name: string; label: string }[] {
  const 名 = (r: 候选客户源) => r.name.trim();
  const 次数 = new Map<string, number>();
  for (const r of rows) 次数.set(名(r), (次数.get(名(r)) ?? 0) + 1);
  return rows.map((r) => {
    if ((次数.get(名(r)) ?? 0) < 2) return { id: r.id, name: r.name, label: 名(r) };
    const 尾号 = (r.phone ?? "").replace(/\D/g, "").slice(-4);
    const 补 = [r.school?.trim() || "", 尾号 ? `尾号 ${尾号}` : ""].filter(Boolean).join(" · ");
    return { id: r.id, name: r.name, label: 补 ? `${名(r)}（${补}）` : 名(r) };
  });
}
