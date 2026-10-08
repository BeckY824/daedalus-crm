/**
 * 本地模式：在用户自己的机器上跑一份完整的 CRM。
 *
 * 服务是随包发布的 Next standalone（server-bundle/，装配见 scripts/build-server.mjs），
 * 用 Electron 的 utilityProcess 拉起来——用户机器上不需要装 Node，也不需要装数据库。
 *
 * **为什么不是 spawn(process.execPath) + ELECTRON_RUN_AS_NODE**（2026-09-16 改）：
 * 那样等于把应用自己的可执行文件再启动一次，macOS 的 LaunchServices 会把它当成
 * 另一个「应用」，于是 Dock 里多出一个没有图标的格子——显示的是系统给无图标
 * Unix 可执行文件的通用图标（黑底绿字 exec）。用户看到的是「打开 CRM 冒出来两个东西」。
 * utilityProcess 是 Electron 专门为「在应用里跑一段 Node」提供的，不产生新的应用实例。
 *
 * 三条不能动的约定：
 *   - **只监听 127.0.0.1**。绑 0.0.0.0 等于把一个自动登录的 CRM 挂到局域网上。
 *   - **COOKIE_SECURE=false**。生产模式下会话 cookie 默认只在 HTTPS 下发，
 *     而这里是 http://127.0.0.1，不显式关掉的话浏览器直接丢弃 cookie，
 *     表现是「登录成功但一直停在登录页」。
 *   - **会话密钥存在数据目录里**。它同时用来加密存储的 AI Key，和数据一起走，
 *     换机器时把数据目录整个拷过去就行。
 */
const { utilityProcess } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");

/** 服务起不来时，把日志的最后这么多行带进错误对话框 */
const 日志回看行数 = 20;
/** 启动超时。冷启动要建库、跑迁移、Next 自己也要几秒 */
const 启动超时毫秒 = 60_000;

let 子进程 = null;
let 日志流 = null;
const 最近日志 = [];

function 记一行(line) {
  最近日志.push(line);
  if (最近日志.length > 200) 最近日志.shift();
}

/** 服务起不来时给人看的那几行 */
function 日志尾巴() {
  return 最近日志.slice(-日志回看行数).join("\n");
}

/**
 * 先问系统要一个空端口再把它交给服务。
 * 中间有一个极小的窗口可能被别的程序抢走，所以调用方要能重试。
 */
function 找一个空端口(想要 = 0) {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(想要, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/**
 * **尽量每次用同一个端口**（2026-10-02 排查桌面端 A1）。
 *
 * 页面的 localStorage 按 origin 存，origin 带着端口。原来每次启动问系统要一个随机端口，
 * 于是外观主题、列表显示哪几列、选的模型、左栏开合、栏宽——每次重启都回到默认。
 * 现在把上次的端口记在这个账号的数据目录里（.port），下次先试它；被占了才换一个新的、再记下来。
 * 一个账号一个目录，所以不同账号的这些偏好也是分开的。
 */
const 分配队列 = new Map();
function 检查可写(dataDir) {
  const probe = path.join(dataDir, `.write-probe-${crypto.randomBytes(8).toString("hex")}`);
  try {
    fs.writeFileSync(probe, "", { flag: "wx", mode: 0o600 });
    fs.unlinkSync(probe);
  } catch (cause) { throw new Error("数据目录不可写，请检查文件夹权限和磁盘空间后重试", { cause }); }
}
const 有效端口 = (v) => Number.isInteger(v) && v >= 1024 && v <= 65535;
function 读端口(dir) {
  try { const port = Number(fs.readFileSync(path.join(dir, ".port"), "utf8").trim()); return 有效端口(port) ? port : 0; }
  catch (e) { if (e.code === "ENOENT") return 0; throw new Error("无法读取本地端口配置，请检查.port文件及权限", { cause: e }); }
}
async function 拿端口(dataDir, { portRoot = path.basename(path.dirname(dataDir)) === "accounts" ? path.dirname(path.dirname(dataDir)) : dataDir } = {}) {
  const root = fs.realpathSync(portRoot);
  const previous = 分配队列.get(root) || Promise.resolve();
  const pending = previous.catch(() => {}).then(() => 分配端口(dataDir, root));
  分配队列.set(root, pending);
  try { return await pending; }
  finally { if (分配队列.get(root) === pending) 分配队列.delete(root); }
}
async function 分配端口(dataDir, root) {
  检查可写(dataDir);
  const f = path.join(dataDir, ".port");
  const current = fs.realpathSync(dataDir);
  const last = 读端口(dataDir);
  try { fs.accessSync(f, fs.constants.W_OK); }
  catch (e) { if (e.code !== "ENOENT") throw new Error("本地端口配置不可写，请检查.port文件权限后重试", { cause: e }); }
  // 即使其他账号的服务没开，其端口仍保留，避免共用localStorage origin。
  const reserved = new Set();
  const dirs = [path.join(root, "data")];
  const accounts = path.join(root, "accounts");
  try { for (const item of fs.readdirSync(accounts, { withFileTypes: true })) if (item.isDirectory()) dirs.push(path.join(accounts, item.name)); }
  catch (e) { if (e.code !== "ENOENT") throw new Error("无法检查其他账号的端口配置", { cause: e }); }
  for (const dir of dirs) {
    if (!fs.existsSync(dir) || fs.realpathSync(dir) === current) continue;
    const port = 读端口(dir); if (port) reserved.add(port);
  }
  if (last && !reserved.has(last)) {
    try { return await 找一个空端口(last); }
    catch (e) { if (e.code !== "EADDRINUSE") throw e; }
  }
  let port = 0;
  for (let i = 0; i < 100; i++) { port = await 找一个空端口(); if (!reserved.has(port)) break; port = 0; }
  if (!port) throw new Error("无法分配独立的本地端口，请稍后重试");
  const temp = `${f}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  try { fs.writeFileSync(temp, String(port), { flag: "wx", mode: 0o600 }); fs.renameSync(temp, f); }
  catch (cause) { throw new Error("无法保存本地端口配置，请检查目录权限和磁盘空间后重试", { cause }); }
  finally { fs.rmSync(temp, { force: true }); }
  return port;
}

/** 会话密钥：有就用，没有就生成一个存下来 */
function 读或生成密钥(dataDir) {
  const f = path.join(dataDir, ".auth-secret");
  try {
    const s = fs.readFileSync(f, "utf8").trim();
    if (s.length >= 32) return s;
  } catch {
    /* 还没有，往下生成 */
  }
  const s = crypto.randomBytes(48).toString("base64");
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}

/** 核对本次子进程的令牌摘要，不把自动登录令牌发给可能抢占端口的程序。 */
function 等就绪(port, 截止, token, 还活着 = () => 子进程 !== null) {
  const expected = crypto.createHash("sha256").update(token).digest("hex");
  return new Promise((resolve, reject) => {
    const 再试一次 = () => {
      if (Date.now() > 截止) return reject(new Error("服务启动超时"));
      if (!还活着()) return reject(new Error("服务进程已退出"));
      const req = http.get({ host: "127.0.0.1", port, path: "/api/desktop/ready", timeout: Math.min(2000, Math.max(1, 截止 - Date.now())) }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; if (body.length > 1024) res.destroy(new Error("本地服务身份响应过长")); });
        res.on("error", reject);
        res.on("end", () => {
          try {
            if (res.statusCode !== 200 || JSON.parse(body).instance !== expected) throw new Error("本地服务身份不匹配，端口可能被其他程序占用，请重试");
            if (!还活着()) throw new Error("服务进程已退出");
            resolve();
          } catch { reject(new Error("本地服务身份不匹配，端口可能被其他程序占用，请重试")); }
        });
      });
      req.on("timeout", () => req.destroy());
      req.on("error", () => setTimeout(再试一次, Math.min(300, Math.max(1, 截止 - Date.now()))));
    };
    再试一次();
  });
}

/**
 * 启动本地服务。返回 { port, token }：
 * token 是这次启动专用的一次性令牌，Electron 拿它去换一张会话票据，
 * 免得本地模式下每次开应用都要输一遍密码。见 app/api/desktop/session/route.ts。
 */
async function start({ bundleDir, dataDir, logFile, portRoot, 额外环境 = {} }) {
  const entry = path.join(bundleDir, "entry.js");
  if (!fs.existsSync(entry)) {
    throw new Error(`安装包里没有本地服务（缺 ${entry}）。开发环境请先在 desktop/ 下跑 npm run build:server`);
  }

  fs.mkdirSync(dataDir, { recursive: true });
  const port = await 拿端口(dataDir, { portRoot });
  const secret = 读或生成密钥(dataDir);
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  const logFd = fs.openSync(logFile, "a", 0o600);
  日志流 = fs.createWriteStream(logFile, { fd: logFd, autoClose: true });
  日志流.on("error", (e) => 记一行(`日志写入失败：${e.message}`));
  日志流.write(`\n===== ${new Date().toISOString()} 启动 =====\n`);

  const token = crypto.randomBytes(24).toString("hex");

  try {
    子进程 = utilityProcess.fork(entry, [], {
      cwd: bundleDir,
      stdio: "pipe",
      serviceName: "Daedalus CRM 本地服务",
      /**
       * Prisma 的查询引擎是一个 .node 原生库，而我们只做了 ad-hoc 签名。
       * 不开这个开关的话，utilityProcess 在强化运行时下会拒绝加载它，
       * 表现是服务起不来、日志里一句代码签名错误。
       */
      allowLoadingUnsignedLibraries: true,
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(port),
        HOSTNAME: "127.0.0.1",
        CRM_DATA_DIR: dataDir,
        DATABASE_URL: `file:${path.join(dataDir, "crm.db").replaceAll("\\", "/")}`,
        AUTH_SECRET: secret,
        // http://127.0.0.1 下必须关掉，否则 cookie 会被浏览器丢弃
        COOKIE_SECURE: "false",
        // 本地模式是单租户，和自部署的开源版走同一条路
        MULTI_TENANT: "",
        DESKTOP_LOCAL: "1",
        DESKTOP_TOKEN: token,
        /**
         * AI 配置（登录云端账号后才有）。llm.ts 的读取顺序是「设置页填的 > 环境变量」，
         * 所以用户在设置里填了自己的 Key 就自动是 BYOK，我们这份只是默认值。
         * 这些值只在进程启动时读一次，登录状态变了要重启服务——见 main.js 的 重启本地服务。
         */
        ...额外环境,
      },
    });

    const 接住 = (流, 前缀) => {
      let 余 = "";
      流.setEncoding("utf8");
      流.on("data", (chunk) => {
        余 += chunk;
        const lines = 余.split("\n");
        余 = lines.pop() ?? "";
        for (const line of lines) {
          记一行(line);
          日志流?.write(`${前缀}${line}\n`);
        }
      });
    };
    接住(子进程.stdout, "");
    接住(子进程.stderr, "! ");

    const 当前子进程 = 子进程;
    子进程.on("exit", (code) => {
      记一行(`进程退出 code=${code}`);
      日志流?.write(`===== 退出 code=${code} =====\n`);
      if (子进程 === 当前子进程) 子进程 = null;
    });

    await 等就绪(port, Date.now() + 启动超时毫秒, token);
    return { port, token };
  } catch (error) { await stop(); 日志流?.end(); 日志流 = null; throw error; }
}

/**
 * 停掉服务。先好好说（SIGTERM，让 SQLite 有机会把 WAL 收尾），
 * 不听话再动手（SIGKILL）。
 *
 * 返回一个等它真的退出的 Promise：重启时必须等旧进程走干净再起新的，
 * 否则两个进程同时开着同一个 SQLite 库。退出应用时不等也行（系统会收尸）。
 */
function stop() {
  if (!子进程) return Promise.resolve();
  const p = 子进程;
  子进程 = null;
  日志流?.end();
  日志流 = null;
  return new Promise((resolve) => {
    let 完事 = false;
    const 收 = () => {
      if (完事) return;
      完事 = true;
      resolve();
    };
    p.once("exit", 收);
    const pid = p.pid;
    try {
      // utilityProcess 的 kill() 不收信号参数，它自己走优雅退出那条路
      p.kill();
    } catch {
      收();
      return;
    }
    setTimeout(() => {
      // 还没走就按着头来一下。utilityProcess 没有 SIGKILL 的入口，用 pid 发
      try {
        if (pid) process.kill(pid, "SIGKILL");
      } catch {
        /* 已经没了 */
      }
      收();
    }, 3000).unref?.();
  });
}

module.exports = { start, stop, 日志尾巴, 运行中: () => 子进程 !== null, 拿端口, 等就绪 };
