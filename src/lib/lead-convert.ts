/**
 * 线索转客户时，线索上的字填到客户的哪一格（审查 M13）。
 *
 * 原来线索名直接成了客户**姓名**：「海川外贸」转过去变成一位叫「海川外贸」的客户，
 * 公司、行业空着，来源丢了——转过去的档案还要人手工再补一遍。
 *
 * 线索的「名称」在通用销售 / 外贸里就是公司名（表单占位写的是「公司名称或线索标题」），
 * 所以档案字段 1 叫「公司」（或「单位」「企业」这类，见下面 字段是公司）时：线索名 → 公司，联系人 → 客户姓名，行业 → 档案字段 3（叫「行业」时）。
 * 教培那套字段是院校 / 专业，线索名多半就是学员本人，照旧当姓名，不往「院校」里塞公司名。
 * 没有联系人时只能用线索名当姓名。
 *
 * 客户表没有「来源」这一列（加列要动迁移），来源写进备注第一行，和导入「对不上的列并进备注」一个做法。
 */
export type 线索字段 = {
  name: string;
  contact: string | null;
  /** 没有联系人时邮箱无处可放（客户表没有邮箱列），写进备注（2026-10-04 L-016） */
  email?: string | null;
  industry: string | null;
  source: string | null;
  remark: string | null;
};

/*
  按叫法认档案字段，不按字面等于（2026-10-04 L-016）。原来是 `fields.school === "公司"`、
  `fields.major === "行业"`：外贸 / 通用用户在业务配置里改成「单位」「所属行业」以后，
  公司名变成了客户姓名、行业整个丢掉，确认框却还说「公司、行业一起带过去」。
  只认得出来的才往里填——改成「微信号」之类的格子，塞公司名进去比空着更糟。
*/
const 像公司 = /公司|单位|企业|集团|工厂|厂家|厂名|商家|店铺|门店|机构|组织|品牌/;
const 像行业 = /行业|领域|产业|赛道|类目|品类/;
export function 字段是公司(名: string): boolean {
  return 像公司.test(名);
}
export function 字段是行业(名: string): boolean {
  return 像行业.test(名);
}

export function 线索转档案(
  lead: 线索字段,
  fields: { school: string; major: string },
): { name: string; school: string | null; major: string | null; remark: string | null } {
  const 名 = lead.name.trim();
  const 联系人 = lead.contact?.trim() || "";
  const 按公司 = 字段是公司(fields.school);
  const 来源行 = lead.source && lead.source !== "其他" ? `线索来源：${lead.source}` : "";
  // 有联系人时邮箱跟着联系人建（leads/actions.ts），没有就进备注，不能悄悄丢（L-016）
  const 邮箱行 = !联系人 && lead.email?.trim() ? `邮箱：${lead.email.trim()}` : "";
  const remark = [来源行, 邮箱行, lead.remark?.trim() ?? ""].filter(Boolean).join("\n") || null;
  return {
    name: 按公司 && 联系人 ? 联系人 : 名,
    school: 按公司 && 联系人 ? 名 : null,
    major: 字段是行业(fields.major) ? lead.industry?.trim() || null : null,
    remark,
  };
}

/**
 * 转化确认框里「会带过去什么」（2026-10-04 L-016）：按 线索转档案 实际会填的格子、用当前叫法说，
 * 没有的不说。原来写死「联系人、公司、行业、来源一起带过去」，改了叫法或没填的也照说，
 * 人信了它，转过去发现一半是空的。返回空串 = 除了姓名电话没别的可带。
 */
export function 转化会带上(lead: 线索字段, fields: { school: string; major: string }): string {
  const 档案 = 线索转档案(lead, fields);
  const 联系人 = lead.contact?.trim() || "";
  return [
    联系人 ? `联系人（${联系人}）` : "",
    档案.school ? fields.school : "",
    档案.major ? fields.major : "",
    lead.email?.trim() ? "邮箱" : "",
    lead.source && lead.source !== "其他" ? "来源" : "",
  ].filter(Boolean).join("、");
}
