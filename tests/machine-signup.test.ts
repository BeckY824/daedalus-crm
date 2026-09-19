/**
 * 「同一台电脑不再重复赠送 30 次」（2026-09-19 用户拍板）。
 *
 * 在这之前免费次数只按账号算，而账号是网页上自助注册的——同一台电脑上再注册一个号
 * 就又是一份 30 次。现在 account 归属方的注册赠送**一台机器只发一次**：
 * 哪个账号领走了这台机器那一份，记在控制面的 MachineSignup 表里（主键是加盐 sha256 的
 * 硬件 UUID）。规则实现只有一份，在 lib/tenant/credits.ts。
 *
 * 这里钉的是四件最容易做坏的事：
 *
 *   1. **不知道是哪台机器 → 不发**。写成"照发"的话，把请求里的机器字段删掉
 *      就又是白送，而且从 /api/gateway/v1/credits 那个和机器八竿子打不着的接口就能漏。
 *   2. **只加不减**：改完之后没有任何人的余额变少。
 *   3. **不误判**：同一台电脑上退出再登录不重复发；换台电脑不会因此领不到本该有的额度，
 *      也不会白占掉新那台电脑的名额。
 *   4. **网页端（workspace 归属方）一字不变**，它没有机器这个口径。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const require_ = createRequire(import.meta.url);

const 根 = path.resolve(__dirname, "..");
const 临时根 = path.join(os.tmpdir(), `crm-machine-${process.pid}`);

beforeAll(() => {
  fs.mkdirSync(临时根, { recursive: true });
  process.env.MULTI_TENANT = "1";
  process.env.CONTROL_DATABASE_URL = `file:${path.join(临时根, "control.db")}`;
  const sql = execFileSync(
    "npx",
    ["prisma", "migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/control.prisma", "--script"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  const ddl = path.join(临时根, "control.sql");
  fs.writeFileSync(ddl, sql);
  execFileSync("node", ["--experimental-sqlite", "-e", `
    const { DatabaseSync } = require('node:sqlite');
    const fs = require('node:fs');
    const db = new DatabaseSync(process.argv[1]);
    db.exec(fs.readFileSync(process.argv[2], 'utf8'));
    db.close();
  `, path.join(临时根, "control.db"), ddl], { stdio: "pipe" });
});

afterAll(() => {
  delete process.env.MULTI_TENANT;
  fs.rmSync(临时根, { recursive: true, force: true });
});

beforeEach(async () => {
  const { control } = await import("@/lib/tenant/control");
  await control.machineSignup.deleteMany({});
  await control.accountAiGrant.deleteMany({});
  await control.accountAiUsage.deleteMany({});
  await control.aiGrant.deleteMany({});
  await control.aiUsage.deleteMany({});
  const { 重置限流 } = await import("@/lib/rate-limit");
  重置限流();
});

let 序号 = 0;

/** 一台"电脑"就是一串加盐 sha256 的十六进制。这里拿名字造一个，形状和真的一样 */
const 电脑 = (名: string) => createHash("sha256").update(`测试机器:${名}`).digest("hex");

async function 建账号() {
  const { createAccount } = await import("@/lib/tenant/accounts");
  return createAccount({
    target: { kind: "phone", value: `1370000${String(序号++).padStart(4, "0")}` },
    password: "abcd1234",
    name: "桌面用户",
  });
}

/** 走真正的登录接口：桌面端就是这么登的，机器标识也只在这条路上带得上来 */
async function 登录(手机号: string, 机器?: string | null) {
  const { POST } = await import("@/app/api/account/token/route");
  const res = await POST(new Request("https://app.example.com/api/account/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.9" },
    body: JSON.stringify({ target: 手机号, password: "abcd1234", name: "某台机器", ...(机器 == null ? {} : { machine: 机器 }) }),
  }));
  expect(res.status, "密码是对的，不该登不上").toBe(200);
  return (await res.json()) as { token: string; credits: { 上限: number; 用掉: number; 还剩: number } };
}

const 余额 = async (accountId: string) => {
  const { 余额: 查 } = await import("@/lib/tenant/credits");
  return 查({ kind: "account", id: accountId });
};

const 赠送条数 = async (accountId: string, reason?: string) => {
  const { control } = await import("@/lib/tenant/control");
  return control.accountAiGrant.count({ where: { accountId, ...(reason ? { reason } : {}) } });
};

describe("一台电脑一份注册赠送", () => {
  it("第一台电脑上的第一个账号照常拿到 30 次", async () => {
    const { 注册赠送 } = await import("@/lib/tenant/credits");
    const 甲 = await 建账号();
    const r = await 登录(甲.phone!, 电脑("甲的笔记本"));
    expect(r.credits.还剩).toBe(注册赠送);
    // 余额够门槛，当天那份每日赠送是懒发的，这会儿不该出现
    expect(await 赠送条数(甲.id, "daily")).toBe(0);
  });

  it("同一台电脑上注册的第二个账号不再拿到注册赠送——只剩每天那几次", async () => {
    const { 注册赠送, 每日赠送 } = await import("@/lib/tenant/credits");
    const { control } = await import("@/lib/tenant/control");
    const 这台 = 电脑("办公室那台");
    const 甲 = await 建账号();
    const 乙 = await 建账号();

    expect((await 登录(甲.phone!, 这台)).credits.还剩).toBe(注册赠送);
    const r = await 登录(乙.phone!, 这台);

    expect(r.credits.还剩, "第二个账号不该再得一份 30").toBe(每日赠送);
    expect(await 赠送条数(乙.id, "signup"), "连一条注册赠送都不该有").toBe(0);
    // 名额还在甲名下，没被后来的人改写
    const 占用 = await control.machineSignup.findUnique({ where: { machineHash: 这台 } });
    expect(占用?.accountId).toBe(甲.id);
    expect(await control.machineSignup.count()).toBe(1);
  });

  it("同一个人在同一台电脑上退出再登录、登十次，都不会重复发", async () => {
    const { 注册赠送 } = await import("@/lib/tenant/credits");
    const { control } = await import("@/lib/tenant/control");
    const 这台 = 电脑("我自己的 Mac");
    const 甲 = await 建账号();
    for (let i = 0; i < 10; i++) await 登录(甲.phone!, 这台);
    expect((await 余额(甲.id)).上限).toBe(注册赠送);
    expect(await 赠送条数(甲.id, "signup")).toBe(1);
    expect(await control.machineSignup.count()).toBe(1);
  });

  it("不同电脑上的不同账号各自照常拿到 30 次", async () => {
    const { 注册赠送 } = await import("@/lib/tenant/credits");
    const 甲 = await 建账号();
    const 乙 = await 建账号();
    expect((await 登录(甲.phone!, 电脑("甲家"))).credits.还剩).toBe(注册赠送);
    expect((await 登录(乙.phone!, 电脑("乙家"))).credits.还剩).toBe(注册赠送);
  });

  it("换台电脑登录：额度照旧，也不会白占掉新那台的名额", async () => {
    /*
      这条是「占住机器」和「发出赠送」严格一对一的意义所在。
      老账号换台电脑登一次，要是顺手把那台电脑的名额占掉，
      家里第二个人再注册就什么都没有——而我们并没有因此多发出去一份。
    */
    const { 注册赠送 } = await import("@/lib/tenant/credits");
    const { control } = await import("@/lib/tenant/control");
    const 甲家 = 电脑("甲家的老笔记本");
    const 共用 = 电脑("家里共用的台式机");
    const 甲 = await 建账号();
    const 乙 = await 建账号();

    await 登录(甲.phone!, 甲家);
    // 甲换到共用那台上登录：额度是他自己的那份，一次都没多也一次都没少
    expect((await 登录(甲.phone!, 共用)).credits.还剩).toBe(注册赠送);
    expect(await control.machineSignup.count(), "只该占住真正发过赠送的那一台").toBe(1);
    expect(await control.machineSignup.findUnique({ where: { machineHash: 甲家 } })).not.toBeNull();

    // 共用那台还没被占，乙在上面注册照样拿得到
    expect((await 登录(乙.phone!, 共用)).credits.还剩).toBe(注册赠送);
  });

  it("大小写不算两台电脑", async () => {
    const { 注册赠送, 每日赠送 } = await import("@/lib/tenant/credits");
    const 这台 = 电脑("大小写");
    const 甲 = await 建账号();
    const 乙 = await 建账号();
    expect((await 登录(甲.phone!, 这台)).credits.还剩).toBe(注册赠送);
    expect((await 登录(乙.phone!, 这台.toUpperCase())).credits.还剩).toBe(每日赠送);
  });
});

describe("已经领过的一条都不许回收", () => {
  it("机器被别人占着，也不影响改版之前就领过的老账号", async () => {
    /*
      改版前的账号在注册那一刻就把 signup 记上了（那时还没有机器这一维）。
      这些人的余额改完之后必须一分不少——赠送表只加不减，改的只是"新的那条还发不发"。
    */
    const { 注册赠送, 赠送 } = await import("@/lib/tenant/credits");
    const 这台 = 电脑("二手来的电脑");
    const 老人 = await 建账号();
    const 新人 = await 建账号();
    // 手工造一条"老账本"：和改版前 signup/actions.ts 写下的那条一模一样
    await 赠送({ kind: "account", id: 老人.id }, { amount: 注册赠送, reason: "signup", key: `${老人.id}:signup` });

    // 这台电脑先被新人占住
    await 登录(新人.phone!, 这台);
    // 老人再在同一台电脑上登录：余额还是他原来那份，不多不少
    const r = await 登录(老人.phone!, 这台);
    expect(r.credits.上限).toBe(注册赠送);
    expect(await 赠送条数(老人.id, "signup")).toBe(1);
  });

  it("用掉一部分之后再登录，用量和余额都不会被改写", async () => {
    const { 注册赠送, 每日赠送, 扣一次 } = await import("@/lib/tenant/credits");
    const 这台 = 电脑("用过几次的机器");
    const 甲 = await 建账号();
    await 登录(甲.phone!, 这台);
    for (let i = 0; i < 5; i++) await 扣一次({ kind: "account", id: 甲.id });
    const 前 = await 余额(甲.id);
    await 登录(甲.phone!, 这台);
    expect(await 余额(甲.id), "再登录一次不该改动任何数字").toEqual(前);
    // 用掉之后余额掉到门槛以下，当天那份每日赠送会被结出来——这是原有行为，和机器无关
    expect(前.上限).toBe(注册赠送 + 每日赠送);
    expect(前.用掉).toBe(5);
  });
});

describe("取不到机器标识时：不发注册赠送，但不是不能用", () => {
  it("不带机器字段（老版本桌面端 / 硬件 UUID 读不出来）→ 没有 30，每天那几次照发", async () => {
    const { 每日赠送 } = await import("@/lib/tenant/credits");
    const { control } = await import("@/lib/tenant/control");
    const 甲 = await 建账号();
    const r = await 登录(甲.phone!, null);
    expect(r.credits.还剩, "每日赠送要照发，不然这个人根本用不了 AI").toBe(每日赠送);
    expect(await 赠送条数(甲.id, "signup")).toBe(0);
    expect(await control.machineSignup.count(), "不知道是哪台机器，就不该往机器表里写").toBe(0);
  });

  it("反复登录也刷不出来——「不知道是哪台机器」必须是不发，不能是照发", async () => {
    const { 每日赠送 } = await import("@/lib/tenant/credits");
    const 甲 = await 建账号();
    for (let i = 0; i < 20; i++) await 登录(甲.phone!, null);
    expect((await 余额(甲.id)).上限).toBe(每日赠送);
  });

  it("乱填的机器标识当没带：占不住名额，也挡不住别人", async () => {
    const { 注册赠送, 每日赠送 } = await import("@/lib/tenant/credits");
    const { control } = await import("@/lib/tenant/control");
    const 甲 = await 建账号();
    const 乙 = await 建账号();
    for (const 乱 of ["", "   ", "abc", "机器", "0".repeat(63), "0".repeat(65), "x".repeat(64), 电脑("少一位").slice(1)]) {
      const r = await 登录(甲.phone!, 乱);
      expect(r.credits.还剩, `「${乱.slice(0, 12)}」不该被当成一台机器`).toBe(每日赠送);
    }
    expect(await control.machineSignup.count()).toBe(0);
    // 甲一条注册赠送都没拿到，也没有挡住任何人
    expect(await 赠送条数(甲.id, "signup")).toBe(0);
    expect((await 登录(乙.phone!, 电脑("正常的机器"))).credits.还剩).toBe(注册赠送);
  });
});

describe("拿不到机器的那两个调用点不是后门", () => {
  it("/api/gateway/v1/credits：拿着令牌反复查余额，刷不出注册赠送", async () => {
    /*
      **这是整个改动最容易漏的地方。** 这个接口只认一枚令牌、拿不到是哪台机器，
      而它原来是会顺手补注册赠送的：要是留着那一下，登录时被拦下的第二个账号
      只要打开应用看一眼额度就补上了，登录那道闸门等于没有。
    */
    const { 每日赠送 } = await import("@/lib/tenant/credits");
    const { 签发 } = await import("@/lib/tenant/device-token");
    const { GET } = await import("@/app/api/gateway/v1/credits/route");
    process.env.GATEWAY_API_KEY = "upstream-key";
    process.env.GATEWAY_BASE_URL = "https://relay.example.com/v1";
    process.env.GATEWAY_MODELS = "deepseek-chat";
    try {
      const 甲 = await 建账号();
      const { token } = await 签发(甲.id, "没走登录接口的机器");
      let 最后 = 0;
      for (let i = 0; i < 5; i++) {
        const res = await GET(new Request("https://app.example.com/api/gateway/v1/credits", {
          headers: { Authorization: `Bearer ${token}` },
        }));
        最后 = (await res.json()).还剩;
      }
      expect(最后).toBe(每日赠送);
      expect(await 赠送条数(甲.id, "signup")).toBe(0);
    } finally {
      delete process.env.GATEWAY_API_KEY;
      delete process.env.GATEWAY_BASE_URL;
      delete process.env.GATEWAY_MODELS;
    }
  });

  it("扣费那条路也刷不出来：没领过注册赠送的账号，上限就是每日那几次", async () => {
    const { 每日赠送, 扣一次 } = await import("@/lib/tenant/credits");
    const 甲 = await 建账号();
    let 放行 = 0;
    for (let i = 0; i < 50; i++) {
      const r = await 扣一次({ kind: "account", id: 甲.id });
      if (!r.ok) break;
      放行++;
    }
    expect(放行).toBe(每日赠送);
  });
});

describe("网页端（workspace 归属方）一字不变", () => {
  const 天 = 86_400_000;
  let ws序号 = 0;
  async function 建工作区() {
    const { control } = await import("@/lib/tenant/control");
    const id = `mws${ws序号++}`;
    await control.workspace.create({
      data: { id, slug: id, name: id, dbFile: `${id}.db`, status: "TRIAL", trialEndsAt: new Date(Date.now() + 3 * 天) },
    });
    return id;
  }

  it("工作区照常拿到注册赠送，压根不需要机器信息", async () => {
    const { 结算赠送, 余额, 注册赠送 } = await import("@/lib/tenant/credits");
    const ws = await 建工作区();
    await 结算赠送({ kind: "workspace", id: ws });
    expect((await 余额({ kind: "workspace", id: ws })).还剩).toBe(注册赠送);
  });

  it("同一台电脑上的两个工作区各自照常——机器这一维在网页端不存在", async () => {
    /*
      网页端一个工作区好几个同事、各自好几台电脑，机器在那边不构成任何口径。
      这条同时钉住「workspace 那一支不许往机器表里写」：写了的话，
      两个团队的人在同一间办公室、同一台会议室电脑上开工作区就会互相挡。
    */
    const { 结算赠送, 余额, 注册赠送 } = await import("@/lib/tenant/credits");
    const { control } = await import("@/lib/tenant/control");
    const 这台 = 电脑("会议室那台");
    const a = await 建工作区();
    const b = await 建工作区();
    await 结算赠送({ kind: "workspace", id: a }, 这台);
    await 结算赠送({ kind: "workspace", id: b }, 这台);
    expect((await 余额({ kind: "workspace", id: a })).还剩).toBe(注册赠送);
    expect((await 余额({ kind: "workspace", id: b })).还剩).toBe(注册赠送);
    expect(await control.machineSignup.count()).toBe(0);
  });
});

describe("控制面的两条安装路径要一致", () => {
  /*
    全新安装走构建期生成的 control-schema.sql（由 control.prisma 生成，Dockerfile 里那一步），
    存量库走 control-migrations/。漏一边的表现不是报错，是那一边的部署上这个功能像没写一样。
  */
  it("control.prisma 里有 MachineSignup", () => {
    const schema = fs.readFileSync(path.join(根, "prisma/control.prisma"), "utf8");
    expect(schema).toContain("model MachineSignup");
  });

  it("control-migrations/ 里有对应的建表，且连跑两遍都不炸", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const 目录 = path.join(根, "control-migrations");
    const 文件 = fs.readdirSync(目录).filter((f) => f.endsWith(".sql")).sort();
    for (const f of 文件) expect(f, `${f} 不符合 NNN-说明.sql 的命名`).toMatch(/^\d{3}-[a-z0-9-]+\.sql$/);

    const 库 = path.join(临时根, "_control-migration-check.db");
    fs.rmSync(库, { force: true });
    const db = new DatabaseSync(库);
    try {
      // 存量库上是接着 control-schema.sql 跑的，这里只跑迁移目录，验的是它自己幂等
      for (let 遍 = 1; 遍 <= 2; 遍++) {
        for (const f of 文件) {
          expect(() => db.exec(fs.readFileSync(path.join(目录, f), "utf8")), `第 ${遍} 遍执行 ${f} 失败`).not.toThrow();
        }
      }
      const 表 = (db.prepare("select name from sqlite_master where type='table'").all() as { name: string }[]).map((t) => t.name);
      expect(表, "存量库补不上这张表，托管版线上这个功能就等于没写").toContain("MachineSignup");
      const 索引 = (db.prepare("select name from sqlite_master where type='index'").all() as { name: string }[]).map((t) => t.name);
      expect(索引).toContain("MachineSignup_accountId_idx");
    } finally {
      db.close();
      fs.rmSync(库, { force: true });
    }
  });
});

describe("桌面端算机器标识的那个模块", () => {
  const 机器 = require_("../desktop/machine.js") as {
    机器哈希: () => string | null;
    算哈希: (原始: unknown) => string | null;
    盐: string;
  };
  const 源码 = fs.readFileSync(path.join(根, "desktop/machine.js"), "utf8");

  it("同一个硬件标识永远算出同一串，不同的算出不同的", async () => {
    const { 算哈希 } = 机器;
    const a = 算哈希("90CBBA5B-CA5C-5B91-9F0A-111111111111");
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(算哈希("90cbba5b-ca5c-5b91-9f0a-111111111111"), "大小写是同一台机器").toBe(a);
    expect(算哈希(" 90CBBA5B-CA5C-5B91-9F0A-111111111111 "), "两头的空白不算").toBe(a);
    expect(算哈希("{90CBBA5B-CA5C-5B91-9F0A-111111111111}"), "注册表那对花括号不算").toBe(a);
    expect(算哈希("90CBBA5B-CA5C-5B91-9F0A-222222222222")).not.toBe(a);
  });

  it("加了盐：传上去的不是硬件 UUID 的裸 sha256", async () => {
    const { 算哈希, 盐 } = 机器;
    const uuid = "90cbba5b-ca5c-5b91-9f0a-333333333333";
    expect(算哈希(uuid)).not.toBe(createHash("sha256").update(uuid).digest("hex"));
    expect(算哈希(uuid)).toBe(createHash("sha256").update(`${盐}:${uuid}`).digest("hex"));
  });

  it("取不到、占位值、命令的报错输出一律是 null，不是一台新机器", async () => {
    const { 算哈希 } = 机器;
    for (const 坏 of [
      "",
      "   ",
      null,
      undefined,
      "0",
      "N/A",
      "unknown",
      "To be filled by O.E.M.",
      "00000000-0000-0000-0000-000000000000",
      "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",
      "ioreg: command not found",
      "ERROR: 系统找不到指定的注册表项或值。",
      "x".repeat(200),
    ]) {
      expect(算哈希(坏), `「${String(坏).slice(0, 20)}」不该算出一个哈希`).toBeNull();
    }
  });

  it("这台机器上算出来的值是稳定的（算两遍一样）", async () => {
    const { 机器哈希 } = 机器;
    const a = 机器哈希();
    expect(机器哈希()).toBe(a);
    if (process.platform === "darwin") {
      expect(a, "macOS 上 ioreg 一定读得到 IOPlatformUUID").toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("**不许**在取不到时编一个标识出来", () => {
    /*
      这条是白送与不白送的分界线。随机值 = 每次启动都是一台新电脑（送到底）；
      存在文件里的 id = 删掉文件就换一份额度；机器名的哈希 = 改个名就是新电脑，
      同时所有同名机器撞成一台。所以这个模块里不该出现任何"造一个 id"的东西。
    */
    for (const 不该有 of ["randomUUID", "randomBytes", "hostname", "Math.random", "userInfo", "Date.now"]) {
      expect(源码.includes(不该有), `machine.js 里不该出现 ${不该有}——取不到就返回 null`).toBe(false);
    }
  });

  it("在打包白名单里，而且壳真的把它传给了本地服务", () => {
    /*
      三处对着同一个环境变量名，都是编译器看不见的字符串。
      改坏了不报错：机器哈希永远取不到，于是**谁都拿不到注册赠送**，而没人会立刻发现。
    */
    const pkg = JSON.parse(fs.readFileSync(path.join(根, "desktop/package.json"), "utf8")) as { build?: { files?: string[] } };
    expect(pkg.build?.files, "不在 files 里就进不了 app.asar").toContain("machine.js");

    const main = fs.readFileSync(path.join(根, "desktop/main.js"), "utf8");
    expect(main).toContain('require("./machine")');
    expect(main).toMatch(/CRM_MACHINE_HASH: 机器\.机器哈希\(\)/);

    const 服务端 = fs.readFileSync(path.join(根, "src/lib/desktop/cloud.ts"), "utf8");
    expect(服务端, "服务端要从同一个环境变量名里取").toContain("CRM_MACHINE_HASH");
    expect(服务端, "登录时要把它带上，否则云端永远不知道是哪台机器").toMatch(/machine: 机器哈希\(\)/);
  });
});
