import { closeTestDatabases } from "./close-databases";
/**
 * 每台桌面端装的是什么：系统、芯片、版本号（lib/tenant/device-info.ts，2026-09-28）。
 * 运营台要分得出 Mac / Windows、看得出谁停在老版本。钉的是：只收认得的值；登录记、启动时更新；
 * 老版本不带头时什么都不写（显示「未知」，不猜）；存量库的迁移补得上这张表。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";


const 根 = path.resolve(__dirname, "..");
const 临时根 = path.join(os.tmpdir(), `crm-device-info-${process.pid}`);

beforeAll(() => {
  fs.mkdirSync(临时根, { recursive: true });
  process.env.MULTI_TENANT = "1";
  process.env.CONTROL_DATABASE_URL = `file:${path.join(临时根, "control.db")}`;
  const sql = execFileSync(
    process.execPath,
    [path.resolve("node_modules/prisma/build/index.js"), "migrate", "diff", "--from-empty", "--to-schema-datamodel", "prisma/control.prisma", "--script"],
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

afterAll(async () => {
  delete process.env.MULTI_TENANT;
  await closeTestDatabases(临时根);
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

async function 建账号() {
  const { createAccount } = await import("@/lib/tenant/accounts");
  return createAccount({ target: { kind: "phone", value: `1390000${String(序号++).padStart(4, "0")}` }, password: "abcd1234", name: "桌面用户" });
}

const 头 = (p?: string, a?: string, v?: string): Record<string, string> => ({
  ...(p === undefined ? {} : { "x-client-platform": p }),
  ...(a === undefined ? {} : { "x-client-arch": a }),
  ...(v === undefined ? {} : { "x-client-version": v }),
});

async function 登录(手机号: string, 客户端头: Record<string, string>) {
  const { POST } = await import("@/app/api/account/token/route");
  const res = await POST(new Request("https://app.example.com/api/account/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.21", ...客户端头 },
    body: JSON.stringify({ target: 手机号, password: "abcd1234", name: "某台机器" }),
  }));
  expect(res.status).toBe(200);
  return (await res.json()) as { token: string };
}

async function 这台记的是(token: string) {
  const { control } = await import("@/lib/tenant/control");
  const { createHash } = await import("node:crypto");
  const row = await control.deviceToken.findUnique({ where: { tokenHash: createHash("sha256").update(token).digest("hex") } });
  return row ? control.deviceInfo.findUnique({ where: { deviceTokenId: row.id } }) : null;
}

describe("读客户端：只收认得的值", () => {
  const 读 = async (h: Record<string, string>) => (await import("@/lib/tenant/device-info")).读客户端(new Request("https://x", { headers: h }));
  it("三样都认得", async () => {
    expect(await 读(头("darwin", "arm64", "0.46.7"))).toEqual({ platform: "darwin", arch: "arm64", version: "0.46.7" });
    expect(await 读(头("WIN32", "x64", "v0.46.7"))).toEqual({ platform: "win32", arch: "x64", version: "0.46.7" });
  });
  it("系统认不出 = 整个当没带（老版本、第三方客户端）", async () => {
    expect(await 读({})).toBeNull();
    expect(await 读(头("<script>", "x64", "0.46.7"))).toBeNull();
  });
  it("芯片、版本认不出就空着，系统照记", async () => {
    expect(await 读(头("win32", "sparc", "latest"))).toEqual({ platform: "win32", arch: null, version: null });
  });
});

describe("登录记一次，启动验令牌时更新", () => {
  beforeEach(() => {
    process.env.GATEWAY_API_KEY = "upstream-key";
    process.env.GATEWAY_BASE_URL = "https://relay.example.com/v1";
    process.env.GATEWAY_MODELS = "deepseek-chat";
  });
  afterEach(() => {
    delete process.env.GATEWAY_API_KEY;
    delete process.env.GATEWAY_BASE_URL;
    delete process.env.GATEWAY_MODELS;
  });

  it("Windows 登录记成 win32；升级后下次打开（/credits）版本跟着变，不用重新登录", async () => {
    const a = await 建账号();
    const { token } = await 登录(a.phone!, 头("win32", "x64", "0.46.7"));
    expect(await 这台记的是(token)).toMatchObject({ platform: "win32", arch: "x64", version: "0.46.7" });

    const { GET } = await import("@/app/api/gateway/v1/credits/route");
    const res = await GET(new Request("https://app.example.com/api/gateway/v1/credits", {
      headers: { Authorization: `Bearer ${token}`, ...头("win32", "x64", "0.46.8") },
    }));
    expect(res.status).toBe(200);
    expect((await 这台记的是(token))?.version).toBe("0.46.8");
  });

  it("老版本不带头：登录照常、查余额照常，只是没有这一行——运营台显示「未知」", async () => {
    const a = await 建账号();
    const { token } = await 登录(a.phone!, {});
    expect(await 这台记的是(token)).toBeNull();
    const { GET } = await import("@/app/api/gateway/v1/credits/route");
    const res = await GET(new Request("https://app.example.com/api/gateway/v1/credits", { headers: { Authorization: `Bearer ${token}` } }));
    expect(res.status).toBe(200);
    expect(await 这台记的是(token)).toBeNull();
  });
});

describe("数设备：顶上那张卡和账号那一列是同一个数", () => {
  it("按系统分，未知的单独一格；说法只列有的", async () => {
    const { 数设备, 分布说法 } = await import("@/lib/tenant/device-info");
    const 分 = 数设备([{ platform: "darwin" }, { platform: "darwin" }, { platform: "win32" }, { platform: null }, {}]);
    expect(分).toEqual({ Mac: 2, Windows: 1, Linux: 0, 未知: 2 });
    expect(分布说法(分)).toBe("Mac 2 · Windows 1 · 未知 2");
  });
});

describe("控制面的两条安装路径要一致", () => {
  it("control.prisma 里有 DeviceInfo，control-migrations/ 里有建表，连跑两遍不炸", async () => {
    const 根 = path.resolve(__dirname, "..");
    expect(fs.readFileSync(path.join(根, "prisma/control.prisma"), "utf8")).toContain("model DeviceInfo");
    const { DatabaseSync } = await import("node:sqlite");
    const 目录 = path.join(根, "control-migrations");
    const 文件 = fs.readdirSync(目录).filter((f) => f.endsWith(".sql")).sort();
    const 库 = path.join(临时根, "_device-info-migration.db");
    const db = new DatabaseSync(库);
    try {
      for (let 遍 = 1; 遍 <= 2; 遍++) for (const f of 文件) db.exec(fs.readFileSync(path.join(目录, f), "utf8"));
      const 表 = (db.prepare("select name from sqlite_master where type='table'").all() as { name: string }[]).map((t) => t.name);
      expect(表, "存量库补不上这张表，线上运营台就分不出 Mac / Windows").toContain("DeviceInfo");
    } finally {
      db.close();
    }
  });
});
