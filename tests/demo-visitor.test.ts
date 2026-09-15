/**
 * 演示区的访客额度。
 *
 * 演示区进门不要码了（整套码 2026-09-15 下线），**按访客计数这一半必须留着**：
 * 去掉它演示区就是个所有人共用、不限次的账单黑洞——那个工作区为了永不过期
 * 被标成了付费态，走工作区那条额度路会被当付费客户直接放行。
 *
 * 所以这里钉的全是"什么时候不放行"，外加一条并发：五次额度被十几个并发请求
 * 同时扣的时候，不该一次都不放行（原来那版就是这样，见 demo-visitor.ts 的注释）。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const 临时根 = path.join(os.tmpdir(), `crm-demo-${process.pid}`);

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

let n = 0;
const 新访客 = () => `v${n++}`;

describe("演示区按浏览器计数", () => {
  it("没进过的浏览器扣不了次数——额度不会凭空出现", async () => {
    const { 演示扣一次, 演示剩余 } = await import("@/lib/tenant/demo-visitor");
    const v = 新访客();
    expect(await 演示剩余(v)).toBeNull();
    const r = await 演示扣一次(v);
    expect(r.ok).toBe(false);
  });

  it("进一次给 5 次，扣完就拦；被拦的那次不计数", async () => {
    const { 进入演示区, 演示扣一次, 演示剩余, 演示对话上限 } = await import("@/lib/tenant/demo-visitor");
    const v = 新访客();
    await 进入演示区(v);
    expect(await 演示剩余(v)).toEqual({ 用掉: 0, 还剩: 演示对话上限 });

    for (let i = 1; i <= 演示对话上限; i++) {
      const r = await 演示扣一次(v);
      expect(r.ok, `第 ${i} 次该放行`).toBe(true);
    }
    const 第六次 = await 演示扣一次(v);
    expect(第六次.ok).toBe(false);
    /**
     * 拦下的那次要还回去。不还的话，被拦十次之后 calls 就到了 15，
     * 而 演示剩余 显示的是「用掉 5、还剩 0」——数字对不上不说，
     * 将来真要给人补几次，补的量还得先填这个坑。
     */
    expect(await 演示剩余(v)).toEqual({ 用掉: 演示对话上限, 还剩: 0 });
  });

  it("重复进入不清零——否则刷新一次就等于再送 5 次", async () => {
    const { 进入演示区, 演示扣一次, 演示剩余 } = await import("@/lib/tenant/demo-visitor");
    const v = 新访客();
    await 进入演示区(v);
    await 演示扣一次(v);
    await 演示扣一次(v);
    await 进入演示区(v);
    expect((await 演示剩余(v))!.用掉).toBe(2);
  });

  it("十几个并发一起扣，放行的正好是额度那么多", async () => {
    /**
     * 原来那版是 updateMany 自增、再查一遍——两步之间别的请求也在自增，
     * 于是每个请求读到的都是最终值：五次额度、十二个并发时十二个都读到 12，
     * 一次都不放行。方向是安全的，但对着演示区猛点几下的人就被莫名其妙挡住了。
     */
    const { 进入演示区, 演示扣一次, 演示对话上限 } = await import("@/lib/tenant/demo-visitor");
    const v = 新访客();
    await 进入演示区(v);
    const 结果 = await Promise.all(Array.from({ length: 12 }, () => 演示扣一次(v)));
    expect(结果.filter((r) => r.ok).length).toBe(演示对话上限);
  });
});

describe("每个 IP 每天能新开几个访客", () => {
  it("超过上限就不再给新额度；带着 cookie 回来的人不占名额", async () => {
    /**
     * 进门的冷却管的是频率（5 分钟 30 次），管不住总量——
     * 丢掉 cookie 就是一份新的 5 次，一天能刷出几万次免费调用。
     * 这条管总量。只数新访客：老访客本来就只有原来那一份。
     */
    const { 今日计数, 记一次今日, 每IP每日演示上限, 重置注册计数 } = await import("@/lib/rate-limit");
    重置注册计数();
    const ip = "198.51.100.44";
    for (let i = 0; i < 每IP每日演示上限; i++) {
      expect(今日计数(`demo:${ip}`)).toBeLessThan(每IP每日演示上限);
      记一次今日(`demo:${ip}`);
    }
    expect(今日计数(`demo:${ip}`)).toBe(每IP每日演示上限);
    // 注册那本账是分开的：演示区刷满了不该把注册也堵上
    expect(今日计数(`signup:${ip}`)).toBe(0);
  });
});

describe("两条进演示区的路都接了限流", () => {
  it("enterDemo 和 continueDemo 共用一个桶", async () => {
    /**
     * continueDemo 进不去新额度（没有 cookie 就直接拒），但它是未登录可调的：
     * 每次两条控制面查询加一次 JWT 签名，不拦的话可以一直打。
     * 和进门那条共用一个桶——它们对服务器的开销是同一类，分开记等于把上限翻倍。
     */
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.resolve(__dirname, "../src/app/demo/actions.ts"), "utf8");
    for (const 名 of ["enterDemo", "continueDemo"]) {
      const i = src.indexOf(`export async function ${名}`);
      expect(i, `找不到 ${名}`).toBeGreaterThan(0);
      const 段 = src.slice(i, src.indexOf("\n}", i));
      expect(段.includes("检查限流(`demo:"), `${名} 要先看桶`).toBe(true);
      expect(段.includes("记一次失败(`demo:"), `${名} 要往桶里记一笔，否则那个闸没人拉`).toBe(true);
    }
  });
});
