/**
 * 排版闸门的长选项种子（10-22 排版普查清单 四-E）：起服务前写业务配置——外贸预设 + 二十多个长选项 + 长字段名。
 * 普查里客户记录页字段名压在值上（.rec-field-k nowrap）、线索来源 Tag 盖住旁边一列，都是长选项 / 长字段名才露出来的；
 * 种子.ts 只灌客户数据，选项还是预设那几个短词，闸门看不到。
 *
 * 为什么不走界面写：设置有进程内缓存，服务起来以后直接改库不生效；界面上一项项加二十多个选项又太慢。
 * 所以挂在 playwright.layout.config.ts 里 prepare.ts 之后、next 之前。切外贸() 见到模版已经是外贸就不再点预设，免得把这些盖回短的
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "../src/generated/prisma";
import { BUSINESS_PRESETS, BUSINESS_KEY } from "../src/lib/business-config";
import { DB, ROOT } from "../e2e-desktop/env";

const 长 = (前: string, n: number) => Array.from({ length: n }, (_, i) => `${前}${i + 1}`);
const 外贸 = BUSINESS_PRESETS["外贸出口"];
const business = {
  ...外贸,
  fields: { school: "公司全称（含英文注册名）", grade: "采购负责人职位 / 职级", major: "主营行业与细分品类" },
  grades: [...外贸.grades, ...长("Head of Global Procurement & Strategic Sourcing (EMEA) 第", 12), "SeniorProcurementManagerForFrozenPoultryAndSeafoodImports"],
  sources: [...外贸.sources, ...长("Alibaba International Station · RFQ 询盘 · 2026 秋季广交会线下展位 ", 12), "LinkedInSalesNavigatorOutboundCampaignAutumn2026"],
  industries: [...外贸.industries, ...长("Frozen poultry, seafood & halal-certified meat products distribution 第", 12), "冷冻禽肉水产品及清真认证肉类产品进出口批发与零售连锁"],
};

const 写 = (p: PrismaClient, key: string, v: unknown) =>
  p.setting.upsert({ where: { key }, update: { value: JSON.stringify(v) }, create: { key, value: JSON.stringify(v) } });

(async () => {
  const p = new PrismaClient({ datasourceUrl: `file:${DB}` });
  try {
    await 写(p, BUSINESS_KEY, business);
    // 选过模版、看过这一版的「已更新到」：不然进门先落到选生意那一页 / 弹窗盖着量
    await 写(p, "onboarding.templateChosenAt", new Date().toISOString());
    await 写(p, "desktop.whatsNewSeen", JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version);
  } finally {
    await p.$disconnect();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
