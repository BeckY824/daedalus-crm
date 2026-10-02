/**
 * 更新记录（CHANGELOG.md）切成一版一段，给桌面端「这一版更新了什么」用（2026-10-02）。
 *
 * 纯函数：输入整份 Markdown，输出一版一段。读文件在 whats-new 那边做——
 * 桌面端的本地服务包里有一份（desktop/scripts/build-server.mjs 拷进去的），开发时读仓库根上那份。
 * 托管版的镜像里没有它：网页版用不上这个功能，读不到就当没有。
 */
export type 一版 = { 版本: string; 日期: string | null; 正文: string };

/** 「## 0.46.14（2026-10-01）」→ 版本 0.46.14、日期 2026-10-01。全角半角括号都认 */
const 版本行 = /^##\s+v?(\d+\.\d+\.\d+)\s*(?:[（(]([^）)]*)[）)])?\s*$/;

export function 切更新记录(md: string): 一版[] {
  const 段: 一版[] = [];
  let 当前: { 版本: string; 日期: string | null; 行: string[] } | null = null;
  for (const 行 of md.split("\n")) {
    const m = 行.match(版本行);
    if (m) {
      if (当前) 段.push({ 版本: 当前.版本, 日期: 当前.日期, 正文: 当前.行.join("\n").trim() });
      当前 = { 版本: m[1], 日期: m[2]?.trim() || null, 行: [] };
      continue;
    }
    // 版本小节以外的二级标题（比如将来加的「## 说明」）不算任何一版，到这儿就收
    if (/^##\s/.test(行)) {
      if (当前) 段.push({ 版本: 当前.版本, 日期: 当前.日期, 正文: 当前.行.join("\n").trim() });
      当前 = null;
      continue;
    }
    当前?.行.push(行);
  }
  if (当前) 段.push({ 版本: 当前.版本, 日期: 当前.日期, 正文: 当前.行.join("\n").trim() });
  return 段;
}

/** 比较两个版本号，a 比 b 新返回正数。只看三段数字 */
export function 比版本(a: string, b: string): number {
  const 拆 = (v: string) => v.replace(/^v/, "").split("-")[0].split(".").map((x) => parseInt(x, 10) || 0);
  const [x, y] = [拆(a), 拆(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

/** 从「上次看过的版本」（不含）到「现在的版本」（含）之间的那几段，新的在前。一次跳了几版就都列出来 */
export function 这次新的(全部: 一版[], 看过: string, 现在: string): 一版[] {
  return 全部
    .filter((s) => 比版本(s.版本, 看过) > 0 && 比版本(s.版本, 现在) <= 0)
    .sort((a, b) => 比版本(b.版本, a.版本));
}

/**
 * 桌面端只看桌面端的那部分：「### 网页团队版…」这一小节（到下一个三级标题或段尾）去掉。
 * 同一份 CHANGELOG 两边都用，网页团队版另外改的那几条写在这一小节里——
 * 桌面端的人看到「同事」「换负责人」只会纳闷这说的是谁。
 */
export function 只留桌面端(正文: string): string {
  const 出: string[] = [];
  let 跳 = false;
  for (const 行 of 正文.split("\n")) {
    if (/^###\s/.test(行)) 跳 = /^###\s*网页团队版/.test(行);
    if (!跳) 出.push(行);
  }
  return 出.join("\n").trim();
}

/**
 * CHANGELOG 里一段话为了在编辑器里好读是折行写的，渲染器（components/Markdown）一行算一段，
 * 弹框里就成了半句一段。连续的普通文字行并成一行；列表、标题、表格、空行照旧分开。
 */
export function 并成段(正文: string): string {
  const 普通 = (行: string) => 行.trim() !== "" && !/^\s*([-*+]\s|\d+[.)]\s|#|\||>)/.test(行);
  const 出: string[] = [];
  for (const 行 of 正文.split("\n")) {
    const 上 = 出.length ? 出[出.length - 1] : null;
    if (上 !== null && 普通(上) && 普通(行) && !/^\*\*.*\*\*$/.test(上.trim()) && !/^\*\*.*\*\*$/.test(行.trim())) {
      出[出.length - 1] = 上 + 行.trim();
    } else 出.push(行);
  }
  return 出.join("\n");
}
