/**
 * 发版前排版闸门的「像真客户」数据（2026-10-19 团队版主动排查；总控：这几天的显示 bug 全是客户先发现的）。
 *
 * 照客户手上真有的样子造：商机名一整句英文（品名 + 条款 + 目的国 + 目标价 + 数量）、英国公司全大写长名、
 * 长供应商中文名、T/T 30/70、US$ 1,234,567.89、一位客户挂好几个商机 / 订单、几种状态和等级。
 * 名字、号码都是编的，不是任何真客户。直接写库（桌面本地模式的 e2e 库，prisma/e2e-desktop.db），id 固定前缀 gate-，重复跑先删后建
 */
import type { PrismaClient } from "../src/generated/prisma";

export const 长句商机 = "chicken breast BFQ. Exw. 10kg/Box. Country is Turkmenistan / Tadjikistan. Target price is 1300$, quantity 500 tons";
export const 客户们 = [
  { k: "scandi", name: "SCANDI PAK EUROPE LTD", country: "英国", level: "A 级", source: "展会获取", follow: "跟进中", decision: "意向强" },
  { k: "long-uk", name: "THE INTERNATIONAL GROUP OF SCANDINAVIAN FOOD PACKAGING AND COLD CHAIN LOGISTICS HOLDINGS LIMITED (UK BRANCH)", country: "英国", level: "B 级", source: "独立站询盘", follow: "待跟进", decision: "了解中" },
  { k: "turkmen", name: "Türkmen Azyk Önümleri Hojalyk Jemgyýeti «Altyn Asyr Trading»", country: "土库曼斯坦", level: "A 级", source: "阿里国际站", follow: "跟进中", decision: "比价中" },
  { k: "nospace", name: "AlRashidTradingAndContractingCompanyLimitedJebelAliFreeZoneAuthority", country: "阿联酋", level: "C 级", source: "WhatsApp", follow: "已成交", decision: "已签约" },
  { k: "cn-long", name: "深圳市宝安区福永街道某某照明电器科技股份有限公司东莞分公司（外贸二部 / 中东大区）", country: "沙特阿拉伯", level: "B 级", source: "老客户返单", follow: "跟进中", decision: "意向强" },
  { k: "arabic", name: "شركة النور للتجارة والمقاولات الكهربائية المحدودة", country: "沙特阿拉伯", level: "A 级", source: "领英", follow: "待跟进", decision: "了解中" },
];
export const 长供应商 = "浙江省宁波市鄞州区某某冷链包装材料有限公司（原宁波某某塑业有限公司，含出口退税开票）";

const 天 = 86400_000;

export async function 灌真客户(db: PrismaClient, 我: string) {
  await db.customer.deleteMany({ where: { id: { startsWith: "gate-" } } });
  await db.supplier.deleteMany({ where: { id: { startsWith: "gate-" } } });
  const 现在 = Date.now();
  const 供应商 = await db.supplier.create({
    data: { id: "gate-sup", name: 长供应商, category: "冷链包装 / 真空袋 / 瓦楞纸箱", region: "浙江宁波", contact: "王经理（外贸部副总监兼工厂厂长）", phone: "+86 574 8888 8888", payment: "T/T 30/70，见提单副本付尾款", rating: "A", remark: "可开 13% 增值税专用发票；MOQ 20000 pcs；交期 25–35 天" },
  });
  for (const [i, c] of 客户们.entries()) {
    const id = `gate-${c.k}`;
    await db.customer.create({
      data: {
        id, name: c.name, phone: `+44 20 7946 ${String(1000 + i)}`, salesOwnerId: 我, followStatus: c.follow, decisionStatus: c.decision,
        lastFollowAt: new Date(现在 - i * 天), remark: "Incoterms 2020 EXW Shenzhen; payment T/T 30/70; samples DHL account 123456789; 每月 15 号前对账",
        extra: { create: { country: c.country, whatsapp: `+44 7700 900${String(100 + i)}`, email: `procurement.department.${c.k}@international-group-holdings.example.co.uk`, source: c.source, level: c.level, website: `https://www.${c.k}-international-group-holdings.example.co.uk/products/frozen-chicken-breast` } },
        contacts: { create: [
          { name: "Mr. Alexander Christopher Montgomery-Smythe", position: "Head of Global Procurement & Supply Chain", phone: "+44 7700 900123", email: "alexander.montgomery-smythe@scandipak-europe.example.co.uk", isPrimary: true },
          { name: "Ms. Aigul Berdimuhamedova", position: "Import Manager (Ashgabat office)", phone: "+993 12 345678", email: "aigul@altynasyr.example.tm" },
        ] },
      },
    });
    const 商机们 = [
      { id: `${id}-o1`, name: 长句商机, amount: 1234567.89, stage: "方案报价" },
      { id: `${id}-o2`, name: "Frozen whole chicken grade A halal certified, 1000g–1200g, IQF, 40ft reefer container × 12, CIF Mersin port", amount: 987654.32, stage: "需求确认" },
      { id: `${id}-o3`, name: "冷冻鸡胸肉 BFQ 10kg/箱 · 土库曼斯坦 / 塔吉克斯坦 · 目标价 1300$/吨 · 500 吨 · 年度框架合同", amount: 12345678.9, stage: "谈判审核" },
    ];
    for (const o of 商机们) {
      await db.opportunity.create({ data: { ...o, customerId: id, ownerId: 我, probability: 60, expectedDealAt: new Date(现在 + 20 * 天), remark: "客户要求先寄样 3 箱，样品费到付；报价有效期 15 天", activityAt: new Date(现在 - 天), money: { create: { currency: "USD" } } } });
      await db.quote.create({ data: { opportunityId: o.id, currency: "USD", lines: { create: [
        { sort: 0, product: "Frozen chicken breast BFQ skinless boneless", spec: "10kg/Box, IQF, 150–250g/pc, Halal", qty: 500, unit: "tons", unitPrice: 1300 },
        { sort: 1, product: "冷冻鸡全翅（中翅 + 翅根）", spec: "10kg/箱，单冻", qty: 120000, unit: "kg", unitPrice: 2.35 },
      ] } } });
    }
    await db.supplierQuote.create({ data: { opportunityId: `${id}-o1`, supplierId: 供应商.id, product: "真空袋 + 五层瓦楞纸箱（带唛头印刷）", unitPrice: 1.234, currency: "CNY", withInvoice: true, moq: 20000, leadDays: 30, verdict: "待定", reason: "比上次贵 8%，但交期快 10 天" } });
    for (const [j, no] of [`PI-20261019-${c.k.toUpperCase()}-EUROPE-000123`, `SC/2026/TM-${String(9000 + i)}/BFQ-CHICKEN-BREAST-500MT`].entries()) {
      await db.tradeOrder.create({
        data: {
          id: `${id}-t${j}`, no, customerId: id, opportunityId: `${id}-o${j + 1}`, ownerId: 我, amount: 1234567.89, currency: "USD", incoterm: j ? "CIF" : "EXW", payment: "T/T 30/70",
          depositDue: 370370.37, depositPaid: j ? 0 : 370370.37, depositAt: j ? null : new Date(现在 - 5 * 天), remark: "40ft reefer × 12；目的港 Turkmenbashi 经 Mersin 转运；清关文件：卫生证 + 原产地证 + Halal",
          purchase: { create: { supplierId: 供应商.id, cost: 6543210.98, currency: "CNY", fxRate: 7.1234 } },
        },
      });
    }
    for (let j = 0; j < 4; j++) {
      await db.followUp.create({
        data: {
          customerId: id, ownerId: 我, type: ["PHONE", "EMAIL", "WHATSAPP", "MEETING"][j], title: "", status: "已完成", occurredAt: new Date(现在 - j * 天 - i * 3600_000),
          opportunityId: j < 3 ? `${id}-o${j + 1}` : null,
          content: j === 1
            ? "客户发来询价：https://www.scandipak-europe.example.co.uk/procurement/rfq/2026/10/frozen-chicken-breast-bfq-exw-10kg-box-turkmenistan-tadjikistan?ref=whatsapp&lang=en"
            : `${长句商机}。客户说下周三之前要确认价格，T/T 30/70，US$ 1,234,567.89，问能不能做 CIF Turkmenbashi。`,
        },
      });
    }
    for (const [j, 差] of [-3, 0, 2].entries()) {
      await db.followPlan.create({ data: { customerId: id, ownerId: 我, subject: `${j === 0 ? "【逾期】" : ""}催 ${c.name} 回签 PI 并确认 30% 定金到账时间（${长句商机.slice(0, 40)}…）`, plannedAt: new Date(现在 + 差 * 天), method: ["电话沟通", "WhatsApp", "邮件"][j] } });
    }
  }
}

/**
 * 10-19 用户 Mac 截图（0.46.21）：客户详情时间线两处越出右边——「其他记录」行头的「订单 xxx」把日期挤出去、绿色订单卡把日期挤出去。
 * main 上 8a8bd9f（.rec-tl-order 可缩省略）、de52983（订单卡头折行）应已修好；这里照截图造一份，闸门里量着
 */
export const 混排订单号 = "adijosidjfjsaofa撒大叔大叔大叔大叔大叔大叔的";
export async function 灌混排订单(db: PrismaClient, 我: string) {
  await db.customer.deleteMany({ where: { id: "gate-mixorder" } });
  const 现在 = Date.now();
  await db.customer.create({ data: { id: "gate-mixorder", name: "订单号混排测试客户", phone: "+86 138 0000 1919", salesOwnerId: 我, followStatus: "跟进中", lastFollowAt: new Date(现在) } });
  // 外贸模版下签约就是订单：绿色订单卡画的是这条签约（订单号 + 金额 + 日期挤在一行）
  await db.contract.create({ data: { id: "gate-mixorder-c0", customerId: "gate-mixorder", amount: 123123121, signedAt: new Date(现在 - 3600_000), owner: { create: { salesOwnerId: 我 } }, money: { create: { currency: "CNY", amountExact: 123123121 } } } });
  await db.tradeOrder.create({ data: { id: "gate-mixorder-t0", no: 混排订单号, customerId: "gate-mixorder", contractId: "gate-mixorder-c0", ownerId: 我, amount: 123123121, currency: "CNY", payment: "T/T 30/70", createdAt: new Date(现在 - 3600_000) } });
  const f = await db.followUp.create({ data: { customerId: "gate-mixorder", ownerId: 我, type: "OTHER", title: "", status: "已完成", occurredAt: new Date(现在 - 600_000), content: "客户确认了唛头和装柜时间" } });
  await db.followUpOrder.create({ data: { followUpId: f.id, orderId: "gate-mixorder-t0", nodeIdx: 0 } });
}
