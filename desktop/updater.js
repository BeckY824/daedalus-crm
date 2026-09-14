/**
 * 检查更新。
 *
 * **只查、只提示，不自动装。** 这是没签名换来的限制，不是偷懒：
 * macOS 的自动更新走 Squirrel.Mac，它会校验新包的代码签名和当前这个是同一张证书。
 * 我们只做了 ad-hoc 签名（免费的那种，身份不固定），校验必然过不去，
 * 硬接 electron-updater 的结果是每次更新都静默失败——比不做更糟，因为没人知道它坏了。
 * 要真正的自动更新就得买 Apple 开发者账号（99 美元/年），那是另一个决定。
 *
 * 所以这里做的是：发现有新版 → 弹一句 → 打开下载页。下载和拖进应用程序文件夹由用户完成。
 *
 * 两个来源，先自家后 GitHub：自家那份是一个我们自己发布的小 JSON，能随时改；
 * GitHub 那份是兜底，不需要我们额外维护——打了 tag、传了产物就自动是最新的。
 *
 * 刻意不引 electron：全是纯逻辑加一次 HTTP，不引就能直接拿 node 测。
 * 当前版本由调用方传进来。
 */

/** 自家的版本信息。发布时更新它，格式见 docs/桌面端安装.md。环境变量可覆盖，方便联调 */
const 自家源 = process.env.CRM_UPDATE_URL || "https://ai-daedalus.com/desktop/latest.json";
/** 兜底：GitHub 的最新 release */
const GitHub源 = process.env.CRM_UPDATE_FALLBACK_URL || "https://api.github.com/repos/BeckY824/daedalus-crm/releases/latest";
/** 没有更具体的下载地址时，打开这一页 */
const 下载页 = "https://ai-daedalus.com/download.html";

/** 两次自动检查的最小间隔。手动点「检查更新」不受它限制 */
const 自动检查间隔毫秒 = 24 * 60 * 60 * 1000;

/**
 * 比较两个版本号。a 比 b 新返回正数。
 * 只看前三段数字，带 -beta 之类后缀的一律当成同一段的更早版本——
 * 我们不发预览版，这样处理足够了，而且不会把 "1.0.0-rc1" 错认成比 "1.0.0" 新。
 */
function 比版本(a, b) {
  const 拆 = (v) => String(v).replace(/^v/, "").split("-")[0].split(".").map((x) => parseInt(x, 10) || 0);
  const [x, y] = [拆(a), 拆(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  }
  // 数字一样时，带后缀的算旧（1.0.0-rc1 < 1.0.0）
  const 后缀 = (v) => (String(v).includes("-") ? 0 : 1);
  return 后缀(a) - 后缀(b);
}

async function 取JSON(url) {
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "DaedalusCRM-Desktop" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * 问一下有没有新版。查不到就返回 null——检查更新失败不该打扰用户，
 * 网络不通、GitHub 被墙、我们自己的站挂了，都不是他该处理的事。
 */
async function 查最新() {
  const 自家 = await 取JSON(自家源);
  if (自家?.version) {
    return { 版本: String(自家.version), 地址: 自家.url || 下载页, 说明: 自家.notes || "" };
  }
  const gh = await 取JSON(GitHub源);
  if (gh?.tag_name) {
    return { 版本: String(gh.tag_name), 地址: gh.html_url || 下载页, 说明: String(gh.body || "").slice(0, 600) };
  }
  return null;
}

/**
 * 检查更新。
 * @param {{当前版本: string, 跳过的版本?: string}} 选项
 * @returns {Promise<null | {版本, 地址, 说明, 当前}>} null 表示不用提示（已是最新 / 查不到 / 用户跳过了这版）
 */
async function 检查({ 当前版本, 跳过的版本 } = {}) {
  const 最新 = await 查最新();
  if (!最新) return null;
  const 当前 = 当前版本;
  if (比版本(最新.版本, 当前) <= 0) return null;
  if (跳过的版本 && 比版本(最新.版本, 跳过的版本) <= 0) return null;
  return { ...最新, 当前 };
}

/** 距离上次自动检查够久了吗 */
function 该自动查了(上次) {
  return !上次 || Date.now() - new Date(上次).getTime() > 自动检查间隔毫秒;
}

module.exports = { 检查, 比版本, 该自动查了, 下载页 };
