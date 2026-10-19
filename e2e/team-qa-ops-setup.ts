/**
 * 运营台排版压测（2026-10-19 团队版主动排查）的 globalSetup：
 *   1. 和 hosted-setup 一样从 prisma/control.prisma 建一个空的控制面库 + 工作区模板 + 共享工作区
 *   2. 直接用 Prisma 往控制面库里灌「长数据」：超长邮箱 / 名字、中文 / 阿拉伯文 / 俄文 / emoji 名字、
 *      长团队名 + 8 个成员（每人 1–3 台设备）、AI / 背调赠送和用量、老用户补 1 次背调、测试账号、长反馈、
 *      运营台加次记录、团队开通记录、工作区长备注、长模型名的调用记录
 *
 * 库在 prisma/e2e-team-qa-ops，和其它套件互不相干。造出来的几个关键 id 写进 seed.json，spec 读它去点详情页。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { PrismaClient } from "../src/generated/control";

const ROOT = path.resolve(__dirname, "..");
export const OPS_DIR = path.resolve(ROOT, "prisma/e2e-team-qa-ops");
export const CONTROL_DB = path.join(OPS_DIR, "control.db");
export const WS_DIR = path.join(OPS_DIR, "ws");
export const SEED_JSON = path.join(OPS_DIR, "seed.json");

/** 运营账号（OPS_ACCOUNTS）：默认算测试账号，用户列表上是「测试 · 运营」 */
export const 运营邮箱 = "ops-team-qa@e2e.local";

const 天 = 86_400_000;
const 前 = (d: number, h = 0) => new Date(Date.now() - d * 天 - h * 3_600_000);
const 后 = (d: number) => new Date(Date.now() + d * 天);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export default async function setup() {
  rmSync(OPS_DIR, { recursive: true, force: true });
  mkdirSync(WS_DIR, { recursive: true });

  const sql = execFileSync(
    "npx",
    ["prisma", "migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/control.prisma", "--script"],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const ddl = path.join(OPS_DIR, "control.sql");
  writeFileSync(ddl, sql);
  execFileSync(
    "node",
    ["--experimental-sqlite", "-e", `
      const { DatabaseSync } = require('node:sqlite');
      const fs = require('node:fs');
      const db = new DatabaseSync(process.argv[1]);
      db.exec(fs.readFileSync(process.argv[2], 'utf8'));
      db.close();
    `, CONTROL_DB, ddl],
    { cwd: ROOT, stdio: "pipe" },
  );
  execFileSync("node", ["--experimental-sqlite", "scripts/build-template.mjs", path.join(WS_DIR, "_template.db")], { cwd: ROOT, stdio: "pipe" });
  execFileSync("npx", ["tsx", "scripts/shared-workspace.ts", "trial@e2e.local", "trial2026", "试用工作区", "shared"], {
    cwd: ROOT,
    stdio: "pipe",
    env: { ...process.env, MULTI_TENANT: "1", CONTROL_DATABASE_URL: `file:${CONTROL_DB}`, WORKSPACE_DIR: WS_DIR, DATABASE_URL: `file:${path.join(OPS_DIR, "never-used.db")}` },
  });

  const db = new PrismaClient({ datasources: { db: { url: `file:${CONTROL_DB}` } } });
  try {
    await 灌数据(db);
  } finally {
    await db.$disconnect();
  }
}

async function 灌数据(db: PrismaClient) {
  const 密码 = "$2a$10$abcdefghijklmnopqrstuuJ5n0iE1rQ3o9mXvYgLx0mJ7k6m0z9a"; // 不用来登录，只占位
  type 人 = { key: string; name: string; email?: string; phone?: string; 注册前: number; 活跃前?: number };
  const 人们: 人[] = [
    { key: "long", name: "欧阳·超级长名字的外贸业务经理张三丰李四王五赵六钱七孙八", email: "a.very.long.email.address.for.layout.testing.purpose.only+crmtest-20261019@extremely-long-subdomain.example-company.co.uk", 注册前: 40, 活跃前: 0 },
    { key: "ar", name: "محمد عبد الرحمن الهاشمي — مدير المبيعات الإقليمي", email: "mohammed.abdulrahman.alhashimi.regional.sales@gulf-trading-company.ae", 注册前: 20, 活跃前: 1 },
    { key: "ru", name: "Александра Константиновна Преображенская-Воскресенская", email: "aleksandra.konstantinovna.preobrazhenskaya@moskva-torgovlya.ru", 注册前: 12, 活跃前: 2 },
    { key: "emoji", name: "🚀🔥小红书运营👩‍💻✨Team Lead🌈🌈🌈🌈🌈", email: "emoji.person.with.a.rather.long.address@example.com", 注册前: 5, 活跃前: 3 },
    { key: "nospace", name: "Supercalifragilisticexpialidocious-Wolfeschlegelsteinhausenbergerdorff", email: "supercalifragilisticexpialidociouswolfeschlegelsteinhausenbergerdorff@x.io", 注册前: 3, 活跃前: 0 },
    { key: "phone", name: "只留手机的王小明", phone: "+8613800138000", 注册前: 2 },
    { key: "m6", name: "成员六号 陈晓晓晓晓晓晓晓晓", email: "member.six.chenxiaoxiao.longname@team-member-company-domain.cn", 注册前: 8, 活跃前: 1 },
    { key: "m7", name: "Jean-Baptiste Emmanuel Zorg de la Fontaine", email: "jean-baptiste.emmanuel.zorg.delafontaine@entreprise-francaise.fr", 注册前: 9, 活跃前: 4 },
    { key: "m8", name: "佐藤 健太郎（大阪支社 海外営業部）", email: "kentaro.sato.osaka.overseas.sales.department@japan-trading.co.jp", 注册前: 10, 活跃前: 6 },
    { key: "test", name: "标成测试账号的超长名字内部测试用户请勿统计", email: "internal.qa.tester.marked.as.test.account+crmtest@e2e.local", 注册前: 15, 活跃前: 0 },
    { key: "ops", name: "运营本人", email: 运营邮箱, 注册前: 60, 活跃前: 0 },
    { key: "out", name: "次数用完的老用户（用了比送的多）", email: "used.more.than.granted.old.user@example.com", 注册前: 50, 活跃前: 0 },
  ];
  const id: Record<string, string> = {};
  for (const p of 人们) {
    const a = await db.account.create({
      data: { name: p.name, email: p.email ?? null, phone: p.phone ?? null, password: 密码, createdAt: 前(p.注册前), lastLoginAt: p.活跃前 === undefined ? null : 前(p.活跃前, 1) },
    });
    id[p.key] = a.id;
  }

  // AI 赠送 + 问了几个问题；「out」问的比送的多（看两处 用 的口径对不对得上）
  const AI = { long: [30, 24], ar: [30, 30], ru: [130, 5], emoji: [30, 0], nospace: [1030, 999], m6: [30, 12], m7: [30, 29], m8: [30, 3], out: [30, 35], phone: [30, 1] } as Record<string, [number, number]>;
  for (const [k, [送, 用]] of Object.entries(AI)) {
    await db.accountAiGrant.create({ data: { accountId: id[k], amount: 30, reason: "signup", key: `${id[k]}:signup`, createdAt: 前(5) } });
    if (送 > 30) await db.accountAiGrant.create({ data: { accountId: id[k], amount: 送 - 30, reason: "admin", key: `admin:seed-${k}`, note: "微信转账 1000 次，客户说下个月还要再买一批，备注写长一点看看换不换行".repeat(1), createdAt: 前(1) } });
    await db.accountAiUsage.create({ data: { accountId: id[k], calls: 用 } });
  }
  // 背调：注册赠送 1 次 + 老用户补发 + 运营台加的；用掉几次（AiResearchRun，没退的 units）
  for (const k of ["long", "ar", "ru", "m6", "m7", "m8"]) {
    await db.researchGrant.create({ data: { accountId: id[k], amount: 1, reason: "signup", key: `${id[k]}:research-signup`, note: k === "long" || k === "ar" ? "老用户补发（10-19）" : `机器 ${sha(k).slice(0, 12)}`, createdAt: 前(0, 3) } });
  }
  await db.researchGrant.create({ data: { accountId: id.long, amount: 50, reason: "admin", key: "admin:seed-research-long", note: "背调 50 次 · 微信转账 ¥795 · 订单号 WX-20261019-000000000000123456789", createdAt: 前(0, 2) } });
  for (let i = 0; i < 7; i++) {
    await db.aiResearchRun.create({ data: { ownerKind: "account", ownerId: id.long, runId: `run-long-${i}`, units: 1, withModel: true, searches: 6, pages: 4, hits: 8, costLi: 7750, ok: i !== 3, refunded: i === 3, at: 前(i % 5), finishedAt: 前(i % 5) } });
  }
  await db.aiResearchRun.create({ data: { ownerKind: "account", ownerId: id.ar, runId: "run-ar", units: 1, withModel: true, at: 前(1) } });

  // 运营台加次记录（AdminCreditLog）：和赠送行同一个 key
  await db.adminCreditLog.create({ data: { key: "admin:seed-research-long", accountId: id.long, kind: "research", amount: 50, by: "operator.with.a.long.email.address@daedalus-ops.example.com", note: "背调 50 次 · 微信转账 ¥795 · 订单号 WX-20261019-000000000000123456789", at: 前(0, 2) } });
  await db.adminCreditLog.create({ data: { key: "admin:seed-nospace", accountId: id.nospace, kind: "ai", amount: 1000, by: "口令", note: "超长不带空格的备注AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", at: 前(1) } });

  // 测试账号：标的（带留痕）
  await db.testAccount.create({ data: { accountId: id.test, on: true, log: ["2026-10-04 15:30 标为测试账号 · ops@example.com", "2026-10-10 09:12 取消测试账号 · 口令", "2026-10-18 21:45 标为测试账号 · operator.with.a.long.email.address@daedalus-ops.example.com"].join("\n") } });

  // 设备：每人 1–3 台，长电脑名；一台吊销的
  const 设备名 = ["张三丰的 MacBook Pro (16-inch, 2024, M4 Max) — 公司财务部借用", "DESKTOP-ABCDEFG-超长的Windows电脑名字-外贸部-前台", "Mac mini"];
  const 令牌: Record<string, string[]> = {};
  const 设备数 = { long: 3, ar: 2, ru: 3, emoji: 1, nospace: 2, m6: 1, m7: 3, m8: 2, test: 1, ops: 1, out: 1 } as Record<string, number>;
  for (const [k, n] of Object.entries(设备数)) {
    令牌[k] = [];
    for (let i = 0; i < n; i++) {
      const t = await db.deviceToken.create({ data: { accountId: id[k], tokenHash: sha(`${k}-${i}`), name: 设备名[i], createdAt: 前(10 - i), lastUsedAt: 前(i), revokedAt: k === "long" && i === 2 ? 前(1) : null } });
      令牌[k].push(t.id);
      if (!(k === "ru" && i === 2)) {
        await db.deviceInfo.create({ data: { deviceTokenId: t.id, platform: i % 2 ? "win32" : "darwin", arch: i % 2 ? "x64" : "arm64", version: i === 0 ? "0.46.21" : i === 1 ? "0.46.9" : "0.46.10" } });
      }
    }
    await db.machineSignup.create({ data: { machineHash: sha(`machine-${k}`), accountId: id[k] } });
  }

  // 模型调用（近 30 天）：长模型名、各种功能
  const 功能 = ["ask", "brief", "draft", "wakeup", "explain", "invite", "parse", "paste", "import", null, "some-new-feature-with-a-very-long-name"];
  const 模型 = ["gpt-5.5", "deepseek-chat", "anthropic/claude-opus-5-5-20261001-extended-thinking-preview-long-model-name"];
  const 调用们 = [];
  for (let i = 0; i < 260; i++) {
    const k = ["long", "ar", "ru", "nospace", "m6", "test", "ops"][i % 7];
    调用们.push({ ownerKind: "account", ownerId: id[k], model: 模型[i % 3], inputTokens: 1200 + i * 37, outputTokens: 300 + i * 11, feature: 功能[i % 功能.length], at: 前(i % 29, i % 20) });
  }
  调用们.push({ ownerKind: "workspace", ownerId: "ws-gone-0000000000000000", model: 模型[2], inputTokens: 9_999_999, outputTokens: 8_888_888, feature: "ask", at: 前(2) });
  await db.aiCall.createMany({ data: 调用们 });

  // 反馈：超长、无空格的长串、多行、长 path、长 platform、带回复
  const 长反馈 = "客户导入了 3000 条外贸询盘之后，团队版里第二个成员的电脑上看不到第一页以后的客户，切换到「全部客户」又能看到，但是点进去之后跟进记录是空的；重启应用、重新登录、换网络都试过了，还是一样。".repeat(4);
  const 反馈们 = [
    { body: 长反馈, who: 人们[0].name + " · " + 人们[0].email, accountId: id.long, path: "/customers/very/long/path/that/keeps/going/and/going?filter=all&sort=lastContactedAt&page=17", version: "0.46.21", platform: "macOS 26.1 (25B5042k) · arm64 · Apple M4 Max · 128 GB · 显示器 6016×3384 @2x · 语言 zh-Hans-CN", source: "desktop", handled: false },
    { body: "https://example.com/a/very/long/url/without/any/spaces/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA?x=1", who: 人们[4].name, accountId: id.nospace, path: "/settings/team", version: "0.46.9", platform: "Windows 11 23H2", source: "desktop", handled: false },
    { body: "مرحبا، لا أستطيع مزامنة البيانات مع الفريق بعد التحديث الأخير. أرجو المساعدة في أقرب وقت ممكن.\n第二行：阿拉伯文混中文\n第三行 🚀🔥", who: 人们[1].name, accountId: id.ar, path: "/", version: "0.46.21", platform: "macOS", source: "desktop", handled: false },
    { body: "网页版反馈，没有账号对应的那种。" + "很长的一句话".repeat(30), who: "试用工作区 · 一个名字特别长的网页版成员名字一个名字特别长的网页版成员名字", accountId: null, path: "/customers", version: null, platform: null, source: "web", handled: false },
    { body: "处理过的旧反馈：Александра пишет, что всё работает.", who: 人们[2].name, accountId: id.ru, path: null, version: "0.46.10", platform: "Windows 10", source: "desktop", handled: true },
  ];
  const 反馈ids: string[] = [];
  for (let i = 0; i < 反馈们.length; i++) {
    const f = await db.feedback.create({ data: { ...反馈们[i], at: 前(i, 2) } });
    反馈ids.push(f.id);
  }
  await db.feedbackReply.create({ data: { feedbackId: 反馈ids[0], to: 人们[0].email!, body: "您好，已经复现，下个版本修复。".repeat(6), by: "operator.with.a.long.email.address@daedalus-ops.example.com", at: 前(0, 1) } });
  await db.feedbackReply.create({ data: { feedbackId: 反馈ids[4], to: 人们[2].email!, body: "Спасибо!", by: "口令", at: 前(3) } });

  // 团队同步：一个超长团队名 + 8 个成员（建的人 + 7），每人 1–3 台同步设备；席位只买了 5 个（超 3）
  const 长团队名 = "深圳市前海超级无敌长名字国际贸易有限公司 · 华南大区海外销售一部第三小组（2026 年度重点客户攻坚专项团队）";
  const t1 = await db.syncTeam.create({ data: { name: 长团队名, ownerAccountId: id.long, joinSecretHash: sha("t1"), active: true, activatedAt: 前(10), createdAt: 前(20) } });
  const 成员 = ["long", "ar", "ru", "emoji", "nospace", "m6", "m7", "m8"];
  for (let i = 0; i < 成员.length; i++) {
    const k = 成员[i];
    await db.syncMember.create({ data: { teamId: t1.id, accountId: id[k], role: i === 0 ? "owner" : "member", joinedAt: 前(20 - i) } });
    const n = (i % 3) + 1;
    for (let j = 0; j < n; j++) {
      await db.syncDevice.create({ data: { teamId: t1.id, device: `d_${k}_${j}`, accountId: id[k], pubKey: "pk" } });
    }
  }
  // 退出的成员不该算进人数
  await db.syncMember.create({ data: { teamId: t1.id, accountId: id.out, role: "member", joinedAt: 前(19), leftAt: 前(2) } });
  await db.syncBatch.createMany({ data: Array.from({ length: 40 }, (_, i) => ({ teamId: t1.id, accountId: id[成员[i % 8]], device: `d_${成员[i % 8]}_0`, size: 1_234_567 + i })) });
  await db.syncTeamPlan.create({ data: { teamId: t1.id, paidUntil: 后(5), seats: 5 } });
  await db.syncTeamPlanLog.createMany({
    data: [
      { teamId: t1.id, by: "operator.with.a.long.email.address@daedalus-ops.example.com", kind: "开通", months: 12, seats: 5, amount: 12345.67, before: null, after: 后(5), note: "小红书私信谈的，客户要求开发票，发票抬头：深圳市前海超级无敌长名字国际贸易有限公司，税号 91440300MA5XXXXXXX", at: 前(10) },
      { teamId: t1.id, by: "口令", kind: "改到期", days: 3, before: 后(2), after: 后(5), note: "上次少算了 3 天", at: 前(3) },
    ],
  });
  await db.adminCreditLog.create({ data: { key: "admin:seed-team-m6", accountId: id.m6, kind: "ai", amount: 100, by: "口令", note: "团队里买的", teamId: t1.id, at: 前(0, 1) } });
  await db.accountAiGrant.create({ data: { accountId: id.m6, amount: 100, reason: "admin", key: "admin:seed-team-m6", note: "团队里买的", createdAt: 前(0, 1) } });

  // 另外几个团队：待开通（短名）、已到期、不限期
  const t2 = await db.syncTeam.create({ data: { name: "小团队", ownerAccountId: id.phone, joinSecretHash: sha("t2"), active: false, createdAt: 前(1) } });
  await db.syncMember.create({ data: { teamId: t2.id, accountId: id.phone, role: "owner" } });
  const t3 = await db.syncTeam.create({ data: { name: "Команда продаж — Москва и Санкт-Петербург 🚀", ownerAccountId: id.ru, joinSecretHash: sha("t3"), active: true, activatedAt: 前(40), createdAt: 前(41) } });
  await db.syncMember.create({ data: { teamId: t3.id, accountId: id.ru, role: "owner" } });
  await db.syncTeamPlan.create({ data: { teamId: t3.id, paidUntil: 前(3), seats: 2 } });
  const t4 = await db.syncTeam.create({ data: { name: "老团队（不限期）", ownerAccountId: id.ar, joinSecretHash: sha("t4"), active: true, activatedAt: 前(60), createdAt: 前(61) } });
  await db.syncMember.create({ data: { teamId: t4.id, accountId: id.ar, role: "owner" } });

  // 工作区（网页版）：长名字、长 slug、长备注、已付费 / 过期 / 停用
  const 共享 = await db.workspace.findFirst({ where: { slug: "shared" } });
  await db.workspace.create({ data: { slug: "very-long-workspace-slug-for-layout-testing-purpose-2026-10-19", name: "广州番禺超长名字的网页版试用团队工作区（华南区域外贸二部）", dbFile: "long.db", status: "TRIAL", trialEndsAt: 后(1), note: "[待核对] 客户说已经转账 ¥1999，但截图看不清楚订单号；等财务确认\n第二行：微信号 abcdefghijklmnopqrstuvwxyz0123456789" } });
  await db.workspace.create({ data: { slug: "paid", name: "已付费团队", dbFile: "paid.db", status: "ACTIVE", trialEndsAt: 前(30), paidUntil: 后(300), note: "年付" } });
  await db.workspace.create({ data: { slug: "expired", name: "过期了的", dbFile: "expired.db", status: "TRIAL", trialEndsAt: 前(3) } });
  const 停 = await db.workspace.create({ data: { slug: "suspended", name: "Арабская команда — فريق المبيعات", dbFile: "susp.db", status: "SUSPENDED", trialEndsAt: 后(3) } });
  await db.membership.create({ data: { accountId: id.ar, workspaceId: 停.id, role: "OWNER" } });
  if (共享) {
    await db.aiGrant.create({ data: { workspaceId: 共享.id, amount: 30, reason: "signup", key: `${共享.id}:seed` } });
    await db.aiUsage.upsert({ where: { workspaceId: 共享.id }, create: { workspaceId: 共享.id, calls: 30 }, update: { calls: 30 } });
  }

  writeFileSync(SEED_JSON, JSON.stringify({ 长用户: id.long, 测试用户: id.test, 无空格用户: id.nospace, 阿拉伯用户: id.ar, 用超了: id.out, 长团队: t1.id, 俄文团队: t3.id, run: randomUUID() }, null, 2));
}
