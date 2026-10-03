/**
 * MCP 的固定端口。
 *
 * 本地服务每次启动都换一个空端口（`找一个空端口()`）——这对应用自己没问题，
 * Electron 知道这次是几号。但 MCP 客户端的配置是**写死在他们那边的一行地址**：
 *
 *     claude mcp add --transport http daedalus http://127.0.0.1:3717/api/mcp
 *
 * 地址一变，用户就得重新配一次；而他不会知道为什么昨天还好好的今天连不上。
 * 所以这里在一个固定端口上开一个极薄的转发：收到什么原样转给当前那个随机端口。
 *
 * 只听 127.0.0.1，只转 /api/mcp 那一条路径。别的一律 404——
 * 这是个长期开着的口子，能转的东西越少越好：转整个应用等于把本地服务
 * 暴露在一个可预测的端口上，那是完全不同的一件事。
 *
 * 端口被别人占了就往后找（3717 → 3718 → …），实际用的那个写进
 * `<数据目录>/mcp.json`，设置页照它显示接入命令。找不到就不开，
 * 应用其余部分照常跑——MCP 是附加能力，不该挡着人用 CRM。
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const 起始端口 = 3717;
const 最多试 = 10;
const 路径 = "/api/mcp";

let 服务 = null;

/** 当前实际监听的端口；没开就是 null */
let 监听端口 = null;

function 转发(req, res, 目标端口) {
  const 上游 = http.request(
    {
      host: "127.0.0.1",
      port: 目标端口,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${目标端口}` },
    },
    (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    },
  );
  上游.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32002, message: "本地服务没在跑" } }));
  });
  req.pipe(上游);
}

/**
 * 连着服务器（团队主机 / 托管版）时的那句话。桥只答本机数据：照常转的话，Claude Code 问「团队里几个客户」，
 * 答的是这台电脑上的个人库（本机服务在跑时），或者一句看不懂的「本地服务没在跑」（0.46.15 第 7 块）。
 */
function 连着服务器说法(地址) {
  return (
    `桌面端现在连着服务器（${地址}），这个端口只答本机数据，先不答——免得把这台电脑上的个人数据当成团队的。` +
    `要查团队那份：在服务器网页的「设置 → AI 接入」里开 MCP，照那里给的地址和令牌接；要查本机：应用菜单「改用本机数据」。`
  );
}

/**
 * 开一个固定端口的转发。`取端口()` 每次现问——本地服务重启会换端口，
 * 而这个桥要一直活着，不能把旧端口记死在闭包里。`连着服务器()` 也现问：切模式不重启这座桥。
 */
async function start({ 取端口, dataDir, 连着服务器 = () => null }) {
  await stop();
  for (let i = 0; i < 最多试; i++) {
    const p = 起始端口 + i;
    const ok = await new Promise((resolve) => {
      const s = http.createServer((req, res) => {
        const u = (req.url ?? "").split("?")[0];
        // 不转的那几种也要把请求体读完再回话：没读完就关，对面看到的是 ECONNRESET，而不是我们那句说明
        const 不转 = (状态, 头, 体) => {
          req.resume();
          req.on("end", () => {
            res.writeHead(状态, 头);
            res.end(体);
          });
        };
        if (u !== 路径) {
          return 不转(404, { "content-type": "text/plain; charset=utf-8" }, "这个端口只转 /api/mcp");
        }
        const 服务器 = 连着服务器();
        if (服务器) {
          return 不转(409, { "content-type": "application/json; charset=utf-8" }, JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32003, message: 连着服务器说法(服务器) } }));
        }
        const 端口 = 取端口();
        if (!端口) {
          return 不转(503, { "content-type": "application/json; charset=utf-8" }, JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32002, message: "本地服务还没起来" } }));
        }
        转发(req, res, 端口);
      });
      s.once("error", () => resolve(false));
      s.listen(p, "127.0.0.1", () => {
        服务 = s;
        监听端口 = p;
        resolve(true);
      });
    });
    if (ok) break;
  }
  if (监听端口 && dataDir) {
    // 设置页和排查问题都要知道它落在哪个端口上
    try {
      fs.writeFileSync(
        path.join(dataDir, "mcp.json"),
        `${JSON.stringify({ url: `http://127.0.0.1:${监听端口}${路径}`, port: 监听端口, at: new Date().toISOString() }, null, 2)}\n`,
      );
    } catch {
      /* 写不了就算了，不值得为一个说明文件把启动搅黄 */
    }
  }
  return 监听端口;
}

function stop() {
  return new Promise((resolve) => {
    if (!服务) return resolve();
    服务.close(() => resolve());
    服务 = null;
    监听端口 = null;
  });
}

module.exports = { start, stop, 端口: () => 监听端口 };
