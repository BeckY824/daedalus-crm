/**
 * 线索转客户时，线索上的字填到客户的哪一格（审查 M13）。
 *
 * 原来线索名直接成了客户**姓名**：「海川外贸」转过去变成一位叫「海川外贸」的客户，
 * 公司、行业空着，来源丢了——转过去的档案还要人手工再补一遍。
 *
 * 线索的「名称」在通用销售 / 外贸里就是公司名（表单占位写的是「公司名称或线索标题」），
 * 所以档案字段 1 叫「公司」时：线索名 → 公司，联系人 → 客户姓名，行业 → 档案字段 3（叫「行业」时）。
 * 教培那套字段是院校 / 专业，线索名多半就是学员本人，照旧当姓名，不往「院校」里塞公司名。
 * 没有联系人时只能用线索名当姓名。
 *
 * 客户表没有「来源」这一列（加列要动迁移），来源写进备注第一行，和导入「对不上的列并进备注」一个做法。
 */
export type 线索字段 = {
  name: string;
  contact: string | null;
  industry: string | null;
  source: string | null;
  remark: string | null;
};

export function 线索转档案(
  lead: 线索字段,
  fields: { school: string; major: string },
): { name: string; school: string | null; major: string | null; remark: string | null } {
  const 名 = lead.name.trim();
  const 联系人 = lead.contact?.trim() || "";
  const 按公司 = fields.school === "公司";
  const 来源行 = lead.source && lead.source !== "其他" ? `线索来源：${lead.source}` : "";
  const remark = [来源行, lead.remark?.trim() ?? ""].filter(Boolean).join("\n") || null;
  return {
    name: 按公司 && 联系人 ? 联系人 : 名,
    school: 按公司 && 联系人 ? 名 : null,
    major: fields.major === "行业" ? lead.industry?.trim() || null : null,
    remark,
  };
}
