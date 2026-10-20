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
 *
 * 还有「失焦就退」：安卓 Chrome 没有相机权限时（10-20 模拟器实测：收回权限后选「不允许」，或者之前选过不再询问），
 * 页面会失焦（系统权限框，或者一个看不见的权限页），几秒后回 cancel，相机始终没出来、页面也没切后台。
 * 相机真开了页面一定切后台（visibilitychange / pagehide），之后的 cancel 才是人点的取消。
 * 所以失焦过、没切后台就 cancel，也当没打开——苹果除外，iPhone 开相机本来就不失焦也不切后台，靠下面的 回来了。
 *
 * 夸克不按 1.5 秒算（10-20 模拟器实测 10.19）：点了先在页面上弹它自己的「相机拍照 / 手机相册」，不失焦、不切后台、
 * 人选之前什么事件都没有，按时间算会在选择框后面冒出「相机没打开」。
 *
 * iPhone Safari 不发失焦（10-20 iOS 18.4 模拟器实测：相机盖上来时没有 blur / visibilitychange，拍完或取消才回 change / cancel），
 * 到 1.5 秒照样会报「没打开」——这时提示躲在相机后面，人看不见；之后 change / cancel 一回来（不是秒退那种）就说明相机开过，
 * 调 回来了() 把提示收掉。真没打开的浏览器要么秒退、要么什么都不回，提示一直留着。
 */

/** click() 之后等多久还没动静算没打开 */
export const 等相机毫秒 = 1500;
/** 这么快就 cancel、之前页面没失焦：系统界面没出来过 */
export const 秒退毫秒 = 800;

type 盯的 = { 输入框: EventTarget; 窗口: EventTarget; 文档: EventTarget };

/**
 * 盯着这一次 click() 有没有把相机 / 选图界面打开。等够了还一点动静没有就调 没开()；
 * 报过之后 change / cancel 才回来（相机其实开过，iPhone Safari 就这样）调 回来了()。
 * 苹果 = iPhone / iPad：不套「失焦就退」；自带选择框 = 点了先弹浏览器自己的选择框（夸克）：不按时间报。
 * 返回「不盯了」：提前收（选好了、换了一次）就调它
 */
export function 盯相机(
  盯: 盯的,
  报: { 没开: () => void; 回来了?: () => void },
  设: { 等?: number; 苹果?: boolean; 自带选择框?: boolean } = {},
): () => void {
  const 事件: [EventTarget, string][] = [
    [盯.输入框, "change"], [盯.输入框, "cancel"],
    [盯.窗口, "blur"], [盯.窗口, "pagehide"], [盯.文档, "visibilitychange"],
  ];
  const 起 = Date.now();
  let 收了 = false;
  let 报过 = false;
  let 失焦了 = false;
  const 收 = () => {
    if (收了) return;
    收了 = true;
    clearTimeout(表);
    for (const [t, e] of 事件) t.removeEventListener(e, 动了);
  };
  function 动了(e: Event) {
    const 是回来 = e.type === "change" || e.type === "cancel";
    // 已经报过没打开：只等 change / cancel 回来，回来了就说明相机开过
    if (报过) { if (是回来) { 收(); 报.回来了?.(); } return; }
    // 失焦：有东西盖上来了，不用再等 1.5 秒；但可能只是权限框，接着看切没切后台
    if (e.type === "blur") { 失焦了 = true; clearTimeout(表); return; }
    // 切后台（相机 / 选图界面真盖上来了）或者选好了：之后怎样都是人自己的事
    if (e.type !== "cancel") { 收(); return; }
    const 秒退 = !失焦了 && Date.now() - 起 < 秒退毫秒;
    const 失焦就退 = 失焦了 && !设.苹果;
    收();
    if (秒退 || 失焦就退) 报.没开();
  }
  for (const [t, e] of 事件) t.addEventListener(e, 动了);
  const 表 = 设.自带选择框 ? undefined : setTimeout(() => { if (收了) return; 报过 = true; 报.没开(); }, 设.等 ?? 等相机毫秒);
  return 收;
}

/** iPhone / iPad（iPadOS 的 Safari 报自己是 Mac，靠触屏认） */
function 是苹果(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** 上一次还没回来的那个框：再点一次时先收掉，免得旧的在页面上越攒越多 */
let 上一个: (() => void) | null = null;

/**
 * 取一张照片。相机 = 带 capture（手机上直接进后置相机）；不带就是相册 / 文件。必须在点击里调（浏览器只认人点的）。
 * 相机没打开时调 报.没开()，但还接着等：相机其实开着、拍回来了或取消了，调 报.回来了()，照片照样给出去
 */
export function 取照片(相机: boolean, 报?: { 没开: () => void; 回来了?: () => void }): Promise<File | null> {
  上一个?.();
  return new Promise((ok) => {
    const i = document.createElement("input");
    i.type = "file";
    i.accept = "image/*";
    if (相机) i.setAttribute("capture", "environment");
    i.style.display = "none";
    i.dataset.testid = 相机 ? "m-scan-input" : "m-scan-album-input";
    // 先盯再挂自己的 change / cancel：同一个 cancel 上盯的那个要先跑（先跑的 完() 会把它摘掉）
    const 不盯 = 相机 && 报 ? 盯相机({ 输入框: i, 窗口: window, 文档: document }, 报, { 苹果: 是苹果(), 自带选择框: /Quark\//.test(navigator.userAgent) }) : () => {};
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

/**
 * 扫名片支持哪些浏览器（2026-10-20 定）：10-15 真机全流程过的（iPhone Safari，安卓 Chrome、Edge，微信，华为浏览器、QQ 浏览器、夸克），
 * 相机这一步 10-20 在模拟器上补测。别的（小米、UC、OPPO / vivo / 三星自带、QQ App 里、认不出来的）给一句推荐，不拦人：
 * 照样能点、「从相册选」照样能用。名字是 m/ui.tsx 认浏览器() 的结果
 */
const 扫名片支持的浏览器 = ["Safari", "Chrome", "Edge", "微信", "华为浏览器", "QQ 浏览器", "夸克"];
export const 推荐浏览器的话 = "扫名片请用 Edge（安卓）或 Safari（iPhone）打开，其他浏览器可能打不开相机";

/** 不在支持名单里就给推荐的话（QQ 里再教怎么跳出去）；在名单里回 null */
export function 换浏览器提示(浏览器: string): string | null {
  if (扫名片支持的浏览器.includes(浏览器)) return null;
  return 浏览器 === "QQ" ? `${推荐浏览器的话}。点右上角 ··· →「在浏览器打开」` : 推荐浏览器的话;
}
