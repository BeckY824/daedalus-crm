/**
 * 本地模式：在用户自己的机器上跑一份完整的 CRM。
 *
 * 服务是随包发布的 Next standalone（server-bundle/，装配见 scripts/build-server.mjs），
 * 用 Electron 自带的 Node 拉起来——用户机器上不需要装 Node，也不需要装数据库。
 *
 * 三条不能动的约定：
 *   - **只监听 127.0.0.1**。绑 0.0.0.0 等于把一个自动登录的 CRM 挂到局域网上。
 *   - **COOKIE_SECURE=false**。生产模式下会话 cookie 默认只在 HTTPS 下发，
 *     而这里是 http://127.0.0.1，不显式关掉的话浏览器直接丢弃 cookie，
 *     表现是「登录成功但一直停在登录页」。
 *   - **会话密钥存在数据目录里**。它同时用来加密存储的 AI Key，和数据一起走，
 *     换机器时把数据目录整个拷过去就行。
 */
const { spawn } = require("node:child_process");
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
function 找一个空端口() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
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

/** 轮询到服务真的能应答为止。只要 HTTP 层给了任何回应就算起来了 */
function 等就绪(port, 截止) {
  return new Promise((resolve, reject) => {
    const 再试一次 = () => {
      if (Date.now() > 截止) return reject(new Error("服务启动超时"));
      if (子进程 === null) return reject(new Error("服务进程已退出"));
      const req = http.get({ host: "127.0.0.1", port, path: "/login", timeout: 2000 }, (res) => {
        res.resume();
        resolve();
      });
      req.on("timeout", () => req.destroy());
      req.on("error", () => setTimeout(再试一次, 300));
    };
    再试一次();
  });
}

/**
 * 启动本地服务。返回 { port, token }：
 * token 是这次启动专用的一次性令牌，Electron 拿它去换一张会话票据，
 * 免得本地模式下每次开应用都要输一遍密码。见 app/api/desktop/session/route.ts。
 */
async function start({ bundleDir, dataDir, logFile, 额外环境 = {} }) {
  const entry = path.join(bundleDir, "entry.js");
  if (!fs.existsSync(entry)) {
    throw new Error(`安装包里没有本地服务（缺 ${entry}）。开发环境请先在 desktop/ 下跑 npm run build:server`);
  }

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  日志流 = fs.createWriteStream(logFile, { flags: "a" });
  日志流.write(`\n===== ${new Date().toISOString()} 启动 =====\n`);

  const port = await 找一个空端口();
  const token = crypto.randomBytes(24).toString("hex");

  子进程 = spawn(process.execPath, [entry], {
    cwd: bundleDir,
    env: {
      ...process.env,
      // 让 Electron 这个可执行文件以纯 Node 的身份跑，不开窗口
      ELECTRON_RUN_AS_NODE: "1",
      NODE_ENV: "production",
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      CRM_DATA_DIR: dataDir,
      DATABASE_URL: `file:${path.join(dataDir, "crm.db")}`,
      AUTH_SECRET: 读或生成密钥(dataDir),
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
    stdio: ["ignore", "pipe", "pipe"],
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

  子进程.on("exit", (code, signal) => {
    记一行(`进程退出 code=${code} signal=${signal}`);
    日志流?.write(`===== 退出 code=${code} signal=${signal} =====\n`);
    子进程 = null;
  });

  await 等就绪(port, Date.now() + 启动超时毫秒);
  return { port, token };
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
    try {
      p.kill("SIGTERM");
    } catch {
      收();
      return;
    }
    setTimeout(() => {
      try {
        p.kill("SIGKILL");
      } catch {
        /* 已经没了 */
      }
      收();
    }, 3000).unref?.();
  });
}

module.exports = { start, stop, 日志尾巴, 运行中: () => 子进程 !== null };
