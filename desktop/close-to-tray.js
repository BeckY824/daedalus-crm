/**
 * Windows 点右上角 ×（2026-10-19 客户反馈：「右上角 X 关闭时弹窗提醒，或最小化到托盘」）。
 *
 * 原来 Windows 上点 × 关了最后一个窗口就整个退出（main.js 的 window-all-closed），
 * 跟进提醒（reminders.js）和团队同步（sync.js）一起停了，人还以为它在后台盯着。
 * 现在第一次点 × 问一句「最小化到托盘 / 退出」，可以勾「记住」，设置 → 桌面端里能改回来。
 * 藏到托盘只是 hide 窗口：窗口一直在，window-all-closed 不会触发，提醒和同步照常跑。
 *
 * Mac 不动：Mac 本来就是关窗不退出，留在 Dock 里。
 *
 * 这里只放判断和那两个系统件（对话框、托盘图标）的样子，Electron 的对象由 main.js 传进来，
 * 测试里换成假的就能钉住。
 */

/** config.json 里 closeAction 的三种值。没存过、存了怪值都当「每次问」 */
const 关窗方式们 = ["ask", "tray", "quit"];

function 规整方式(v) {
  return 关窗方式们.includes(v) ? v : "ask";
}

/**
 * 这一下 close 该怎么办：
 *   放行 —— 真关（Mac、要退出了、系统关机注销、选了「退出」）
 *   藏   —— 拦下来，藏到托盘
 *   问   —— 拦下来，弹框问
 *
 * 「要退出了」= app.quit() 走到这里：before-quit 已经把 正在退出 置上（换包、装更新都是走 app.quit），
 * 这时拦下来就把退出卡死了，所以一律放行
 */
function 该怎么关({ 平台, 要退出了, 方式 }) {
  if (平台 !== "win32" || 要退出了) return "放行";
  const m = 规整方式(方式);
  if (m === "quit") return "放行";
  if (m === "tray") return "藏";
  return "问";
}

/** 弹框问一次。回 { 方式: "tray" | "quit" | null（点了取消 / 关了框）, 记住 } */
async function 问一下(dialog, win) {
  const { response, checkboxChecked } = await dialog.showMessageBox(win, {
    type: "question",
    title: "关闭 Daedalus CRM",
    message: "最小化到托盘，还是退出？",
    detail: "最小化到托盘：窗口收起来，跟进提醒和团队同步照常在后台跑，点右下角托盘图标回来。\n退出：提醒和同步都停。",
    buttons: ["最小化到托盘", "退出", "取消"],
    defaultId: 0,
    cancelId: 2,
    checkboxLabel: "记住我的选择（设置 → 桌面端里能改）",
    checkboxChecked: false,
    noLink: true,
  });
  const 方式 = response === 0 ? "tray" : response === 1 ? "quit" : null;
  return { 方式, 记住: 方式 !== null && checkboxChecked === true };
}

/** 托盘右键菜单。要跟数 > 0 时多一项直接去计划页（同 Mac Dock 右键那一项） */
function 托盘菜单项({ 名字, 要跟数, 回窗口, 去计划页, 退出 }) {
  return [
    { label: `打开 ${名字}`, click: 回窗口 },
    ...(要跟数 > 0 ? [{ label: `今天要跟 ${要跟数} 条`, click: 去计划页 }] : []),
    { type: "separator" },
    { label: "退出", click: 退出 },
  ];
}

/**
 * 托盘图标。第一次藏到托盘时才建（选了「退出」的人任务栏右下角不多一个图标），建了就留到退出。
 * 单击（Windows 上左键）回窗口；右键是上面那份菜单
 */
function 建托盘({ Tray, Menu, nativeImage, 图标路径, 名字, 回窗口, 去计划页, 退出 }) {
  const 图 = nativeImage.createFromPath(图标路径);
  const 托盘 = new Tray(图.isEmpty() ? 图 : 图.resize({ width: 16, height: 16, quality: "best" }));
  let 数 = 0;
  const 刷菜单 = () => {
    托盘.setToolTip(数 > 0 ? `${名字} · 今天要跟 ${数} 条` : 名字);
    托盘.setContextMenu(Menu.buildFromTemplate(托盘菜单项({ 名字, 要跟数: 数, 回窗口, 去计划页, 退出 })));
  };
  刷菜单();
  托盘.on("click", 回窗口);
  return {
    托盘,
    设要跟数(n) {
      if (n === 数) return;
      数 = n;
      刷菜单();
    },
    提示藏到这里() {
      // 只在 Windows 有气泡；刚选了「最小化到托盘」的那一次说一声它去哪了
      if (typeof 托盘.displayBalloon === "function") {
        托盘.displayBalloon({ title: 名字, content: "还在后台运行，跟进提醒照常。点这里的图标回来，右键可以退出。", iconType: "info" });
      }
    },
    销毁() {
      if (!托盘.isDestroyed()) 托盘.destroy();
    },
  };
}

module.exports = { 关窗方式们, 规整方式, 该怎么关, 问一下, 托盘菜单项, 建托盘 };
