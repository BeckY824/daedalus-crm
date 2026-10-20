/**
 * 扫名片取照片（手机伴侣 /m）：拍照 / 从相册选，都是一个隐藏的 <input type=file>，click() 之后交给系统。
 *
 * 2026-10-20 客户反馈「点了没反应」：浏览器或微信没有相机权限、国产浏览器静默拒绝时，click() 之后系统什么都不弹，
 * 页面上也什么都不显示。所以拍照时盯 1.5 秒：相机或选图界面盖上来，页面一定会失焦或切后台（blur / visibilitychange /
 * pagehide），选好或取消会有 change / cancel；这几样一样都没有，就当相机没打开，给人一句话和「从相册选」。
 *
 * 例外是「秒退」：系统界面根本没出来、浏览器直接回一个 cancel（Chromium 打不开选图框时就这样，100 毫秒左右；
 * 安卓上不接选图的内置浏览器 / WebView 也是这条路）。人不可能在 0.8 秒里看到相机再点取消，
 * 所以 cancel 来得这么快、之前页面又没失焦，也当没打开。
 * 判断错了（相机其实开了、只是这台浏览器不发这些事件）也不要紧：提示只是一句话，照片拍回来照样走识别、提示自己收起。
 */

/** click() 之后等多久还没动静算没打开 */
export const 等相机毫秒 = 1500;
/** 这么快就 cancel、之前页面没失焦：系统界面没出来过 */
export const 秒退毫秒 = 800;

type 盯的 = { 输入框: EventTarget; 窗口: EventTarget; 文档: EventTarget };

/**
 * 盯着这一次 click() 有没有把相机 / 选图界面打开。等够了还一点动静没有就调 没开()。
 * 返回「不盯了」：提前收（选好了、换了一次）就调它
 */
export function 盯相机(盯: 盯的, 没开: () => void, 等 = 等相机毫秒): () => void {
  const 事件: [EventTarget, string][] = [
    [盯.输入框, "change"], [盯.输入框, "cancel"],
    [盯.窗口, "blur"], [盯.窗口, "pagehide"], [盯.文档, "visibilitychange"],
  ];
  const 起 = Date.now();
  let 收了 = false;
  const 收 = () => {
    if (收了) return;
    收了 = true;
    clearTimeout(表);
    for (const [t, e] of 事件) t.removeEventListener(e, 动了);
  };
  // 有任何一样就说明系统界面出来过（或者人已经选完了），不用再等；秒退的 cancel 除外
  function 动了(e: Event) {
    const 秒退 = e.type === "cancel" && Date.now() - 起 < 秒退毫秒;
    收();
    if (秒退) 没开();
  }
  for (const [t, e] of 事件) t.addEventListener(e, 动了);
  const 表 = setTimeout(() => { if (收了) return; 收(); 没开(); }, 等);
  return 收;
}

/** 上一次还没回来的那个框：再点一次时先收掉，免得旧的在页面上越攒越多 */
let 上一个: (() => void) | null = null;

/**
 * 取一张照片。相机 = 带 capture（手机上直接进后置相机）；不带就是相册 / 文件。必须在点击里调（浏览器只认人点的）。
 * 相机没打开时调 没开()，但还接着等：相机晚一点开了、拍回来了，照样给出去
 */
export function 取照片(相机: boolean, 没开?: () => void): Promise<File | null> {
  上一个?.();
  return new Promise((ok) => {
    const i = document.createElement("input");
    i.type = "file";
    i.accept = "image/*";
    if (相机) i.setAttribute("capture", "environment");
    i.style.display = "none";
    i.dataset.testid = 相机 ? "m-scan-input" : "m-scan-album-input";
    // 先盯再挂自己的 change / cancel：同一个 cancel 上盯的那个要先跑（先跑的 完() 会把它摘掉）
    const 不盯 = 相机 && 没开 ? 盯相机({ 输入框: i, 窗口: window, 文档: document }, 没开) : () => {};
    const 完 = (f: File | null) => {
      不盯();
      i.remove();
      if (上一个 === 收掉) 上一个 = null;
      ok(f);
    };
    const 收掉 = () => 完(null);
    上一个 = 收掉;
    i.addEventListener("change", () => 完(i.files?.[0] ?? null));
    i.addEventListener("cancel", () => 完(null));
    document.body.appendChild(i);
    i.click();
  });
}
