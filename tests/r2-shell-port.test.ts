/**
 * R2 · 本地服务端口（desktop/local-server.js 拿端口，本轮新加的 .port）。
 *
 * localStorage 按 origin（含端口）存：端口一变，外观 / 列表列 / 选的模型 / 栏宽就回默认。
 * 所以 .port 坏了、越界、被占、写不进去时，要么照旧用上次的，要么换一个能用的——
 * **绝不能因为 .port 起不来服务**。
 */
import { describe, it, expect, afterAll, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import Module from "node:module";

const M = Module as unknown as { _load: (...a: unknown[]) => unknown };
const 原load = M._load;
M._load = function (req: unknown, ...rest: unknown[]) {
  if (req === "electron") return { utilityProcess: {} };
  return 原load.call(this, req, ...rest);
};
const { 拿端口 } = Module.createRequire(import.meta.url)("../desktop/local-server.js");
afterAll(() => {
  M._load = 原load;
});

const 目录们: string[] = [];
const 新目录 = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "r2-port-"));
  目录们.push(d);
  return d;
};
afterEach(() => {
  for (const d of 目录们.splice(0)) {
    try {
      fs.chmodSync(d, 0o700);
    } catch {
      /* 已经删了 */
    }
    fs.rmSync(d, { recursive: true, force: true });
  }
});

const 记下的 = (d: string) => fs.readFileSync(path.join(d, ".port"), "utf8");
const 占住 = async (port: number, host = "127.0.0.1") => {
  const s = net.createServer();
  await new Promise<void>((r, j) => {
    s.once("error", j);
    s.listen(port, host, () => r());
  });
  return s;
};
const 放开 = (s: net.Server) => new Promise<void>((r) => s.close(() => r()));
const 能听 = async (port: number) => {
  const s = await 占住(port);
  await 放开(s);
  return true;
};

describe(".port 坏了 / 越界：不抛、换一个能用的、记下新的", () => {
  for (const [说明, 内容] of [
    ["不是数字", "abc"],
    ["空文件", ""],
    ["越界 70000", "70000"],
    ["特权端口 80", "80"],
    ["负数", "-1"],
    ["小数", "50123.5"],
    ["0", "0"],
    ["前后带空白和换行", "  \n"],
    ["一串乱码", "\u0000ÿ\u0001"],
  ] as const) {
    it(说明, async () => {
      const d = 新目录();
      fs.writeFileSync(path.join(d, ".port"), 内容);
      const p = await 拿端口(d);
      expect(Number.isInteger(p) && p >= 1024 && p <= 65535).toBe(true);
      expect(Number(记下的(d))).toBe(p);
      expect(await 能听(p)).toBe(true);
    });
  }

  it("带换行的合法端口照样认（手工编辑过）", async () => {
    const d = 新目录();
    const 一 = await 拿端口(d);
    fs.writeFileSync(path.join(d, ".port"), `${一}\n`);
    expect(await 拿端口(d)).toBe(一);
  });

  it(".port 是个目录：不抛，给一个能用的端口", async () => {
    const d = 新目录();
    fs.mkdirSync(path.join(d, ".port"));
    const p = await 拿端口(d);
    expect(await 能听(p)).toBe(true);
  });
});

describe("被占 / 写不进", () => {
  it("上次的端口被别的程序占了（127.0.0.1）：换一个，并且记下新的", async () => {
    const d = 新目录();
    const 一 = await 拿端口(d);
    const s = await 占住(一);
    const 二 = await 拿端口(d);
    await 放开(s);
    expect(二).not.toBe(一);
    expect(Number(记下的(d))).toBe(二);
  });

  /*
    别的程序听的是 0.0.0.0:P（很多开发服务器默认这样）。macOS / Linux 上 libuv 给监听套接字开了 SO_REUSEADDR，
    于是 127.0.0.1:P 还能再绑上——拿端口 判「空」，本地服务也真能起来，127.0.0.1 上的请求落到我们这边。
    这里钉的是「拿得到、且确实能在 127.0.0.1 上听」，不至于让服务起不来。
  */
  it("上次的端口被别人在 0.0.0.0 上听着：拿到的端口在 127.0.0.1 上确实能用", async () => {
    const d = 新目录();
    const 一 = await 拿端口(d);
    const s = await 占住(一, "0.0.0.0");
    const p = await 拿端口(d);
    expect(await 能听(p).catch(() => false)).toBe(true);
    await 放开(s);
  });

  it("目录不可写：照样给端口（只是下次又换一个，偏好会丢——见报告 C）", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const d = 新目录();
    fs.chmodSync(d, 0o500);
    const 一 = await 拿端口(d);
    const 二 = await 拿端口(d);
    expect(await 能听(一)).toBe(true);
    expect(fs.existsSync(path.join(d, ".port"))).toBe(false);
    // 记不下 → 每次都是新的随机端口 → localStorage 每次都是空的（回到修之前的样子）
    expect(二).not.toBe(一);
  });

  it(".port 只读（权限 0400）、上次的端口被占：换到的新端口记不下，但不抛", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) return;
    const d = 新目录();
    const 一 = await 拿端口(d);
    fs.chmodSync(path.join(d, ".port"), 0o400);
    const s = await 占住(一);
    const 二 = await 拿端口(d);
    await 放开(s);
    expect(二).not.toBe(一);
    expect(Number(记下的(d))).toBe(一); // 还是旧的：下次旧的空出来又回去，偏好回来
  });
});

describe("多账号各自的 .port", () => {
  it("两个账号目录各记各的，互不覆盖；各自重启后还是各自那个", async () => {
    const 甲 = 新目录();
    const 乙 = 新目录();
    const a = await 拿端口(甲);
    const b = await 拿端口(乙);
    expect(a).not.toBe(b);
    expect(await 拿端口(甲)).toBe(a);
    expect(await 拿端口(乙)).toBe(b);
  });

  /*
    【C】换账号时新账号第一次拿的是随机端口，**不避开别的账号记着的端口**。
    撞上的概率很小（一万多分之一），但撞上就是两个账号共用一个 origin：
    外观、选的模型、栏宽这些 localStorage 偏好会串（没有业务数据）。
    把整个账号目录拷给另一个账号（手工搬数据）时是必然撞上。
  */
  it("【C-1】把甲的目录整个拷成乙的（手工搬数据）：两个账号同一个端口 → 同一个 origin", async () => {
    const 甲 = 新目录();
    const 乙 = 新目录();
    const a = await 拿端口(甲);
    fs.copyFileSync(path.join(甲, ".port"), path.join(乙, ".port"));
    expect(await 拿端口(乙)).toBe(a);
  });
});
