/**
 * Daedalus CRM 桌面客户端。
 *
 * 两种模式，同一个安装包：
 *   本地   —— 数据和服务都在这台机器上，装完就能用，不需要服务器、不需要联网
 *             （AI 功能除外，那要连模型接口）
 *   服务器 —— 连一台已经部署好的实例，团队共用一份数据
 *
 * 新装的默认是本地；从旧版本升上来的保持原样连服务器，见 读配置()。
 *
 * 本地模式**必须先登录云端账号**（2026-09-15 起）：账号免费、邮箱注册，
 * 数据仍然只在本机，账号只用来记 AI 次数——收费差异全在 AI 上。
 * 没登录就不开主窗口，见 必须登录()。
 */
const { app, BrowserWindow, shell, dialog, Menu, clipboard } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const 本地服务 = require("./local-server");
const 云端 = require("./cloud");
const 更新 = require("./updater");

const APP_NAME = "Daedalus CRM";

/**
 * 把用户数据目录挪到一个**不含空格**的路径下。
 *
 * 默认会是 ~/Library/Application Support/Daedalus CRM —— 名字里有空格，
 * 而数据库地址是以 `file:` URL 的形式交给 Prisma 的，空格在那里是雷。
 * 必须在 app ready 之前改，否则 Electron 自己的缓存已经落在旧路径上了。
 */
const 旧数据目录 = app.getPath("userData");
app.setPath("userData", path.join(app.getPath("appData"), "DaedalusCRM"));
const 数据根 = app.getPath("userData");

const CONFIG_FILE = path.join(数据根, "config.json");
const 数据目录 = path.join(数据根, "data");
const 日志文件 = path.join(数据根, "logs", "server.log");
const 密码文件 = path.join(数据目录, ".init-password");
云端.初始化(数据目录);

/** 随包发布的本地服务。打包后在 Resources/server，开发时在 desktop/server-bundle */
const 服务目录 = app.isPackaged ? path.join(process.resourcesPath, "server") : path.join(__dirname, "server-bundle");

/** 旧版本默认指向的托管版地址，只在从旧配置迁移过来时用得上 */
const 默认服务器 = process.env.CRM_URL || "https://app.ai-daedalus.com";

let win = null;
/** 本地服务起来之后的地址与一次性令牌 */
let 本地 = null;

function 读配置() {
  // 从旧版本升级上来的：配置还在带空格的老目录里，搬过来
  if (!fs.existsSync(CONFIG_FILE)) {
    const 旧 = path.join(旧数据目录, "config.json");
    if (旧 !== CONFIG_FILE && fs.existsSync(旧)) {
      fs.mkdirSync(数据根, { recursive: true });
      fs.copyFileSync(旧, CONFIG_FILE);
    }
  }
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    return {
      // 老配置里没有 mode，但有 serverUrl——那是已经在用托管版的人，
      // 升级后突然切到空空如也的本地库会以为数据没了，所以保持连服务器
      mode: c.mode ?? "server",
      serverUrl: (c.serverUrl || 默认服务器).replace(/\/+$/, ""),
    };
  } catch {
    return { mode: "local", serverUrl: 默认服务器 };
  }
}

function 写配置(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

/* ---------- 启动 ---------- */

async function 启动本地() {
  // 云端账号带来的 AI 配置只在进程启动时读一次，所以登录状态一变就要重启，见 重启本地服务
  本地 = await 本地服务.start({
    bundleDir: 服务目录,
    dataDir: 数据目录,
    logFile: 日志文件,
    额外环境: 云端.模型环境(),
  });
}

/** 换了 AI 配置之后让它生效。旧进程要等它真的退出再起新的，否则两个进程开着同一个库 */
async function 重启本地服务() {
  await 本地服务.stop();
  await 启动本地();
  if (win) win.loadURL(本地入口());
}

/** 本地模式的首页：带令牌换一张会话票据，换完自己跳去 /dashboard */
function 本地入口() {
  return `http://127.0.0.1:${本地.port}/api/desktop/session?t=${本地.token}`;
}

function 当前地址() {
  const cfg = 读配置();
  return cfg.mode === "local" ? 本地入口() : cfg.serverUrl;
}

function 建窗口() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: APP_NAME,
    /**
     * 不画系统标题栏：标题「Daedalus CRM」在侧栏已经有一个标了，标题栏上再写一遍是重复。
     * 红黄绿钮嵌进页面左上（侧栏顶部留了 44px），那一块和中栏头、页头的 CSS 都标了
     * -webkit-app-region: drag，窗口照样拖得动——页面是服务端渲染的也不妨碍这条 CSS 生效。
     * 壳靠 UA 里的 "Electron/" 判断自己在桌面端里，见 (app)/layout.tsx。
     */
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 20, y: 16 },
    backgroundColor: "#fafafa",
    show: false,
    icon: path.join(__dirname, "assets/icon.png"),
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  win.once("ready-to-show", () => win.show());
  win.loadURL(当前地址());

  // 站外链接交给系统浏览器，免得用户在没有地址栏的窗口里迷路
  win.webContents.setWindowOpenHandler(({ url }) => {
    const 自己 = 读配置().mode === "local" ? `http://127.0.0.1:${本地?.port}` : 读配置().serverUrl;
    if (!url.startsWith(自己)) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  win.webContents.on("did-fail-load", (_e, code, desc, _url, isMainFrame) => {
    if (!isMainFrame) return;
    // -3 是主动取消（自己发起的跳转打断了上一次加载），不是错误
    if (code === -3) return;
    const cfg = 读配置();
    if (cfg.mode === "local") {
      报告本地故障(`${desc}（${code}）`);
      return;
    }
    dialog
      .showMessageBox(win, {
        type: "warning",
        title: "连不上服务器",
        message: `连接 ${cfg.serverUrl} 失败`,
        detail: `${desc}（${code}）\n\n检查一下网络，或确认服务器地址填对了。`,
        buttons: ["重试", "改服务器地址", "改用本地数据", "退出"],
        defaultId: 0,
      })
      .then(({ response }) => {
        if (response === 0) win.loadURL(cfg.serverUrl);
        else if (response === 1) 问服务器地址();
        else if (response === 2) 切到本地();
        else app.quit();
      });
  });
}

function 报告本地故障(原因) {
  dialog
    .showMessageBox(win ?? null, {
      type: "error",
      title: "本地服务没能启动",
      message: "本机的 CRM 服务没能起来",
      detail: `${原因}\n\n最后几行日志：\n${本地服务.日志尾巴() || "（没有输出）"}`,
      buttons: ["查看完整日志", "改用服务器", "退出"],
      defaultId: 0,
    })
    .then(({ response }) => {
      if (response === 0) shell.showItemInFolder(日志文件);
      else if (response === 1) 问服务器地址();
      else app.quit();
    });
}

/* ---------- 模式切换 ---------- */

async function 切到本地() {
  写配置({ ...读配置(), mode: "local" });
  if (!云端.读()) {
    const 旧 = win;
    win = null;
    旧?.close();
    await 必须登录();
  }
  try {
    if (!本地服务.运行中()) await 启动本地();
    win ? win.loadURL(本地入口()) : 建窗口();
  } catch (e) {
    报告本地故障(e?.message ?? String(e));
  }
  建菜单();
}

function 问服务器地址() {
  const cur = 读配置().serverUrl;
  // Electron 没有内置输入框，用一个极简页面代替
  const input = new BrowserWindow({
    width: 480,
    height: 250,
    resizable: false,
    title: "服务器地址",
    parent: win ?? undefined,
    modal: Boolean(win),
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  input.loadURL(
    "data:text/html;charset=utf-8," +
      encodeURIComponent(`
    <body style="font:14px -apple-system,'PingFang SC','Microsoft YaHei';padding:22px;margin:0;background:#fafafa">
      <div style="font-weight:600;margin-bottom:10px">服务器地址</div>
      <input id="u" value="${cur}" style="width:100%;padding:9px 11px;font-size:14px;
        border:1px solid #d9dee7;border-radius:7px;box-sizing:border-box">
      <div style="margin-top:8px;color:#6b7280;font-size:12px">
        填你们自己部署的那台机器的地址。团队共用一份数据时用这个模式。
      </div>
      <div style="margin-top:20px;text-align:right">
        <button onclick="window.close()" style="padding:7px 16px;margin-right:8px">取消</button>
        <button onclick="crm.save(document.getElementById('u').value)"
          style="padding:7px 16px;background:#2f6bff;color:#fff;border:none;border-radius:6px">连接</button>
      </div>
    </body>`),
  );
  input.webContents.once("ipc-message", (_e, ch, url) => {
    if (ch !== "save-url") return;
    const clean = String(url).trim().replace(/\/+$/, "");
    // 只认 http(s)：填错协议会让窗口白屏，且看不出是为什么
    if (!/^https?:\/\/.+/.test(clean)) return;
    写配置({ mode: "server", serverUrl: clean });
    input.close();
    // 本地服务留着不停：切回来时不用再等一次冷启动
    win ? win.loadURL(clean) : 建窗口();
    建菜单();
  });
}

/* ---------- 云端账号 ---------- */

/**
 * 云端账号窗：登录 / 注册 / 找回密码，三块面板共用一个窗口。
 *
 * 本地模式下数据在这台机器上，云端只剩两件事：认领一个账号，和借它调模型——
 * 没有它 AI 入口整个不出现，CRM 其余功能照常。
 *
 * **注册跳去网页，不在这里做。** 试过在应用内直接开账号（只开账号不开工作区，
 * 因为数据在用户自己机器上），结果是那种账号进不了网页版——它没有工作区，
 * 网页登录会被挡下，而同一个邮箱又注册不了第二次。一个账号在两个地方行为不一样，
 * 比多点一次浏览器糟得多。所以注册只有一条路：网页那条，开出来的账号两边都能用。
 *
 * 找回密码留在窗口里：那时账号已经存在，没有上面那个问题。
 *
 * 画哪几个入口由服务端说了算：打开窗口时先问一次 /api/account/policy。
 * 问不到（断网、老版本服务端）就只留登录——那是永远走得通的那条。
 *
 * Electron 没有内置输入框，页面只能用 data: URL 拼。里面的脚本**不用模板字符串**：
 * 整段本身就在一个模板字符串里，嵌套那一层的转义极易写错且报错很难看懂。
 */
/**
 * 本地模式的门：没有云端账号就不开主窗口。关掉这个窗口等于退出应用。
 * 登录成功后由调用方接着起本地服务、开主窗口。
 */
function 必须登录() {
  return new Promise((resolve) => 登录云端({ 必须: true, 成功: resolve }));
}

function 登录云端({ 必须 = false, 成功 } = {}) {
  let 成功了 = false;
  const w = new BrowserWindow({
    width: 470,
    // 打开时先按登录面板给个高度，页面量完自己会通知主进程调整（见下面的 cloud-resize）
    height: 330,
    resizable: false,
    title: "云端账号",
    parent: win ?? undefined,
    modal: Boolean(win),
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  const 云 = 云端.默认云端.replace(/\/+$/, "");
  // 必须登录时，没登成功就关窗 = 不想用了
  w.on("closed", () => {
    if (必须 && !成功了) app.quit();
  });

  w.loadURL(
    "data:text/html;charset=utf-8," +
      encodeURIComponent(`
    <style>
      body { font:13px -apple-system,'PingFang SC','Microsoft YaHei'; padding:22px; margin:0; background:#fafafa; color:#111 }
      .h { font-weight:600; font-size:15px; margin-bottom:4px }
      .s { color:#6b7280; font-size:12px; margin-bottom:14px; line-height:1.6 }
      input[type=text], input[type=password] {
        width:100%; padding:9px 11px; font-size:14px; border:1px solid #d9dee7;
        border-radius:7px; box-sizing:border-box; margin-bottom:10px; background:#fff }
      button { padding:7px 16px; font-size:13px; border-radius:6px; border:1px solid #d9dee7; background:#fff }
      button.primary { background:#2f6bff; color:#fff; border:none }
      button[disabled] { opacity:.55 }
      .row { display:flex; align-items:center; justify-content:space-between; margin-top:18px }
      .links a { color:#2f6bff; margin-right:12px; cursor:pointer; font-size:12px }
      .tip { color:#6b7280; font-size:12px; margin:-4px 0 10px }
      #msg { display:none; padding:8px 11px; border-radius:7px; font-size:12px; margin-bottom:12px; line-height:1.6 }
      #msg.err { background:#fef2f2; color:#b91c1c }
      #msg.ok { background:#eff6ff; color:#1d4ed8 }
      .codeline { display:flex; gap:8px }
      .codeline input { flex:1 }
    </style>
    <body>
      <div id="msg"></div>

      <div id="p-login">
        <div class="h">${必须 ? "登录后开始使用" : "登录云端账号"}</div>
        <div class="s">${必须 ? "账号免费，邮箱注册。数据仍然只在这台机器上，不会上传；账号只用来记 AI 次数。" : "用它来调 AI。数据仍然只在这台机器上，不会上传。"}</div>
        <input type="text" id="u" placeholder="手机号或邮箱">
        <input type="password" id="p" placeholder="密码">
        <div class="row">
          <div class="links">
            <a id="to-reg" style="display:none">注册新账号 ↗</a>
            <a id="to-reset" style="display:none">忘记密码？</a>
          </div>
          <div>
            <button onclick="window.close()">${必须 ? "退出应用" : "取消"}</button>
            <button class="primary" id="do-login">登录</button>
          </div>
        </div>
      </div>

      <div id="p-reset" style="display:none">
        <div class="h">找回密码</div>
        <div class="s">用注册时的邮箱收一个验证码，就能设新密码。<br>改完之后网页端的登录状态会全部失效，本机的令牌不受影响。</div>
        <input type="text" id="fu" placeholder="注册时用的邮箱">
        <div class="codeline">
          <input type="text" id="fcode" placeholder="邮件里的 6 位验证码" maxlength="6">
          <button id="fsend">发送验证码</button>
        </div>
        <input type="password" id="fp" placeholder="设置新密码">
        <div class="tip">至少 8 位，含字母和数字</div>
        <div class="row">
          <div class="links"><a class="back">返回登录</a></div>
          <div><button class="primary" id="do-reset">设置新密码</button></div>
        </div>
      </div>

      <script>
        var $ = function (id) { return document.getElementById(id); };
        var 面板 = { login: $('p-login'), reset: $('p-reset') };
        var 按钮 = document.getElementsByTagName('button');

        function 说(text, 好) {
          var m = $('msg');
          m.textContent = text || '';
          m.className = 好 ? 'ok' : 'err';
          m.style.display = text ? 'block' : 'none';
          if (window.__量好了) 量高();
        }
        /**
         * 内容有多高窗口就多高：两块面板差了一截，固定高度必然有一块下面空着一片。
         * 量的是**当前这块面板的底边**，不是 body 的高——body 会被窗口撑满，
         * 拿它去算，窗口只会越变越高。
         */
        function 量高() {
          var 开着 = null;
          for (var k in 面板) if (面板[k].style.display !== 'none') 开着 = 面板[k];
          if (!开着) return;
          crm.resize(Math.ceil(开着.getBoundingClientRect().bottom) + 22);
        }
        function 切(名) {
          for (var k in 面板) 面板[k].style.display = k === 名 ? 'block' : 'none';
          说('');
          量高();
        }
        function 忙(on) {
          for (var i = 0; i < 按钮.length; i++) 按钮[i].disabled = on;
        }

        // 注册在网页上办：那条路开出来的账号带工作区，网页和桌面端都认
        $('to-reg').onclick = function () { crm.open(云 + '/signup?from=desktop'); };
        $('to-reset').onclick = function () { 切('reset'); };
        var backs = document.getElementsByClassName('back');
        for (var i = 0; i < backs.length; i++) backs[i].onclick = function () { 切('login'); };
        var 云 = ${JSON.stringify(云)};

        $('do-login').onclick = function () {
          if (!$('u').value.trim() || !$('p').value) return 说('手机号（或邮箱）和密码都要填');
          忙(true); 说(''); crm.login($('u').value.trim(), $('p').value);
        };
        $('fsend').onclick = function () {
          if (!$('fu').value.trim()) return 说('先填邮箱');
          忙(true); 说(''); crm.code($('fu').value.trim(), 'reset');
        };
        $('do-reset').onclick = function () {
          if (!$('fu').value.trim() || !$('fcode').value.trim() || !$('fp').value) return 说('邮箱、验证码和新密码都要填');
          忙(true); 说('');
          crm.reset({ target: $('fu').value.trim(), code: $('fcode').value.trim(), password: $('fp').value });
        };

        document.body.addEventListener('keydown', function (e) {
          if (e.key !== 'Enter') return;
          if (面板.reset.style.display === 'block') $('do-reset').click();
          else $('do-login').click();
        });

        crm.onReply(function (m) {
          忙(false);
          if (m.kind === 'policy') {
            $('to-reg').style.display = m.register ? 'inline' : 'none';
            $('to-reset').style.display = m.reset ? 'inline' : 'none';
            return;
          }
          if (m.kind === 'reset-done') { 切('login'); $('u').value = m.target || ''; 说('密码已经改好了，用新密码登录', true); return; }
          说(m.text, m.kind === 'hint');
        });

        crm.policy();
        $('u').focus();
        window.__量好了 = true;
        量高();
      </script>
    </body>`),
  );

  w.webContents.on("ipc-message", async (_e, ch, payload) => {
    const 回 = (m) => {
      if (!w.isDestroyed()) w.webContents.send("cloud-reply", m);
    };

    if (ch === "open-external") {
      // 只认我们自己的站点：这个窗口里的链接是写死的，出现别的一定是哪里错了
      const u = String(payload ?? "");
      if (u.startsWith(云 + "/")) shell.openExternal(u);
      return;
    }

    if (ch === "cloud-resize") {
      const h = Math.round(Number(payload));
      // 只认合理范围内的数：页面是我们自己的，但窗口尺寸不该由一个数字随便摆布
      if (Number.isFinite(h) && h >= 260 && h <= 760 && !w.isDestroyed()) w.setContentSize(470, h);
      return;
    }

    if (ch === "cloud-policy") {
      回({ kind: "policy", ...(await 云端.策略()) });
      return;
    }

    if (ch === "cloud-code") {
      const r = await 云端.发码(String(payload?.target ?? "").trim());
      // hint 只在开发环境有值（线上永远不回显验证码），有就直接显示，省得去翻日志
      回(r.ok ? { kind: "hint", text: r.data?.hint ?? "验证码已经发出去了，10 分钟内有效" } : { kind: "error", text: r.error });
      return;
    }

    if (ch === "cloud-reset") {
      const target = String(payload?.target ?? "").trim();
      const r = await 云端.重置密码({ target, code: String(payload?.code ?? "").trim(), password: String(payload?.password ?? "") });
      回(r.ok ? { kind: "reset-done", target } : { kind: "error", text: r.error });
      return;
    }

    if (ch !== "cloud-login") return;

    const target = String(payload?.target ?? "").trim();
    const r = await 云端.登录(target, String(payload?.password ?? ""));
    if (!r.ok) {
      回({ kind: "error", text: r.error });
      return;
    }

    if (必须) {
      // 门开了：本地服务和主窗口由调用方接着起
      成功了 = true;
      w.close();
      建菜单();
      成功?.(r.data);
      return;
    }
    // 手上有令牌了，重启本地服务让它带上新的 AI 配置
    w.close();
    建菜单();
    try {
      await 重启本地服务();
    } catch (e) {
      报告本地故障(e?.message ?? String(e));
      return;
    }
    const 还剩 = r.data?.credits?.还剩;
    dialog.showMessageBox(win ?? null, {
      type: "info",
      title: "登录成功",
      message: `已登录：${r.data?.account?.name ?? target}`,
      detail: 还剩 == null ? "AI 功能已启用。" : `AI 功能已启用，免费次数还剩 ${还剩} 次。`,
    });
  });
}

async function 退出云端() {
  const { response } = await dialog.showMessageBox(win ?? null, {
    type: "question",
    title: "退出云端账号",
    message: 读配置().mode === "local" ? "退出之后要重新登录才能进应用" : "退出之后 AI 功能会停用",
    detail: "本机的数据不受影响，仍然都在。重新登录即可恢复。",
    buttons: ["退出", "取消"],
    defaultId: 1,
    cancelId: 1,
  });
  if (response !== 0) return;
  await 云端.退出();
  建菜单();
  if (读配置().mode === "local") {
    // 本地模式没有账号就不能用：关主窗、停服务、回到门口
    const 旧 = win;
    win = null;
    旧?.close();
    await 本地服务.stop();
    await 必须登录();
    try {
      await 启动本地();
      建窗口();
    } catch (e) {
      报告本地故障(e?.message ?? String(e));
    }
    return;
  }
  try {
    await 重启本地服务();
  } catch (e) {
    报告本地故障(e?.message ?? String(e));
  }
}

async function 显示额度() {
  const r = await 云端.余额();
  if (!r.ok) {
    dialog.showMessageBox(win ?? null, { type: "error", title: "查不到额度", message: r.error });
    return;
  }
  const { 上限, 用掉, 还剩, 每日赠送 } = r.data ?? {};
  dialog.showMessageBox(win ?? null, {
    type: "info",
    title: "AI 免费次数",
    message: `还剩 ${还剩} 次`,
    detail: `一共送过 ${上限} 次，已经用掉 ${用掉} 次。${每日赠送 ? `\n每天登录再送 ${每日赠送} 次。` : ""}\n也可以在设置页填自己的模型 API Key，那样不走这个额度。`,
  });
}

/* ---------- 检查更新 ---------- */

/**
 * 检查更新。只查、只提示、不自动装——没签名的 macOS 应用没法走系统那套自动更新，
 * 理由见 updater.js 顶部。手动点菜单时 静默=false，查不到也要给个回话。
 */
async function 检查更新(静默) {
  const cfg = 读配置();
  if (静默 && !更新.该自动查了(cfg.lastUpdateCheck)) return;
  写配置({ ...cfg, lastUpdateCheck: new Date().toISOString() });

  const 新版 = await 更新.检查({ 当前版本: app.getVersion(), 跳过的版本: 静默 ? cfg.skipVersion : undefined });
  if (!新版) {
    if (!静默) {
      dialog.showMessageBox(win ?? null, {
        type: "info",
        title: "检查更新",
        message: "已经是最新版本",
        detail: `当前版本 ${app.getVersion()}。`,
      });
    }
    return;
  }

  const { response } = await dialog.showMessageBox(win ?? null, {
    type: "info",
    title: "有新版本",
    message: `发现新版本 ${新版.版本}（当前 ${新版.当前}）`,
    detail: `${新版.说明 ? `${新版.说明}\n\n` : ""}下载后把新的应用拖进「应用程序」覆盖旧的即可，数据不受影响。`,
    buttons: ["去下载", "跳过这个版本", "以后再说"],
    defaultId: 0,
    cancelId: 2,
  });
  if (response === 0) shell.openExternal(新版.地址);
  else if (response === 1) 写配置({ ...读配置(), skipVersion: 新版.版本 });
}

/* ---------- 菜单 ---------- */

function 显示本机密码() {
  let 密码 = null;
  try {
    密码 = fs.readFileSync(密码文件, "utf8").trim();
  } catch {
    /* 还没建库，或者是从旧版本升上来的库 */
  }
  if (!密码) {
    dialog.showMessageBox(win ?? null, {
      type: "info",
      title: "本机账号",
      message: "还没有本机密码",
      detail: "本地数据库还没建立，或者它是从别处搬来的。先用一次本地模式再来看。",
    });
    return;
  }
  dialog
    .showMessageBox(win ?? null, {
      type: "info",
      title: "本机账号",
      message: `管理员账号：${云端.读()?.contact || "admin"}`,
      detail: `密码：${密码}\n\n本地模式下打开应用就是登录状态，平时用不到它。\n登出之后、或者把这个库搬到服务器上时才需要。`,
      buttons: ["复制密码", "好"],
      defaultId: 0,
    })
    .then(({ response }) => {
      if (response === 0) clipboard.writeText(密码);
    });
}

function 建菜单() {
  const cfg = 读配置();
  const isMac = process.platform === "darwin";
  const 应用菜单 = {
    label: APP_NAME,
    submenu: [
      { role: "about", label: `关于 ${APP_NAME}` },
      { type: "separator" },
      {
        label: "使用本机数据",
        type: "radio",
        checked: cfg.mode === "local",
        click: () => 切到本地(),
      },
      {
        label: cfg.mode === "server" ? `连接服务器（${cfg.serverUrl}）…` : "连接服务器…",
        type: "radio",
        checked: cfg.mode === "server",
        click: () => 问服务器地址(),
      },
      { type: "separator" },
      ...(cfg.mode === "local"
        ? 云端.读()
          ? [
              { label: `云端账号：${云端.读().contact || 云端.读().name}`, enabled: false },
              { label: "AI 剩余次数…", click: 显示额度 },
              { label: "退出云端账号", click: 退出云端 },
            ]
          : [{ label: "登录云端账号…（AI 功能需要）", click: 登录云端 }]
        : []),
      { type: "separator" },
      { label: "本机账号密码…", enabled: cfg.mode === "local", click: 显示本机密码 },
      { label: "检查更新…", click: () => 检查更新(false) },
      { label: "打开数据文件夹", click: () => shell.openPath(数据目录) },
      { label: "查看服务日志", click: () => shell.showItemInFolder(日志文件) },
      { type: "separator" },
      ...(isMac ? [{ role: "hide", label: `隐藏 ${APP_NAME}` }] : []),
      { role: "quit", label: `退出 ${APP_NAME}` },
    ],
  };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      应用菜单,
      {
        label: "编辑",
        submenu: [
          { role: "undo", label: "撤销" },
          { role: "redo", label: "重做" },
          { type: "separator" },
          { role: "cut", label: "剪切" },
          { role: "copy", label: "复制" },
          { role: "paste", label: "粘贴" },
          { role: "selectAll", label: "全选" },
        ],
      },
      {
        label: "视图",
        submenu: [
          { role: "reload", label: "重新加载" },
          { role: "resetZoom", label: "实际大小" },
          { role: "zoomIn", label: "放大" },
          { role: "zoomOut", label: "缩小" },
          { type: "separator" },
          { role: "togglefullscreen", label: "全屏" },
        ],
      },
    ]),
  );
}

/* ---------- 生命周期 ---------- */

// 单实例：重复点图标时聚焦已开的窗口，而不是开第二个（第二个还会去抢端口）
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    建菜单();
    if (读配置().mode === "local") {
      if (!云端.读()) await 必须登录();
      try {
        await 启动本地();
      } catch (e) {
        报告本地故障(e?.message ?? String(e));
        return;
      }
    }
    建窗口();
    // 开机就查会和冷启动抢资源，而且那时窗口还没画出来，弹窗会挡在前面。等一会儿再说
    setTimeout(() => 检查更新(true).catch(() => {}), 15_000);
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) 建窗口();
    });
  });

  // 退出前把本地服务收掉，别留一个孤儿进程占着端口和数据库
  app.on("before-quit", () => 本地服务.stop());
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
