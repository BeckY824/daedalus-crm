/**
 * 从 desktop/assets/icon.svg 生成应用图标产物。
 *
 *   node scripts/make-icon.mjs
 *
 * 出三样：
 *   desktop/assets/icon.png    1024×1024，Windows / Linux 打包和 Electron 窗口用
 *   desktop/assets/icon.icns   macOS 打包用（含 16 到 512 的 @1x/@2x 全套）
 *   desktop/assets/icon-preview.png  16/32/64/128 并排，用来检查小尺寸糊不糊
 *
 * 用 Playwright 渲染而不是 sips：sips 不吃 SVG，而这个图标用了渐变、模糊、径向高光，
 * 得有个真浏览器才画得对。Playwright 仓库里本来就有（e2e 在用），不额外加依赖。
 */
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const 根 = path.resolve(import.meta.dirname, "..");
const svg路径 = path.join(根, "desktop/assets/icon.svg");
const 出目录 = path.join(根, "desktop/assets");
const 临时 = path.join(根, ".icon-build");

/** icns 要的尺寸：每档一个 @1x 一个 @2x */
const 档位 = [16, 32, 128, 256, 512];

const svg = readFileSync(svg路径, "utf8");
const browser = await chromium.launch();

async function 渲染(边长, 输出) {
  const page = await browser.newPage({ viewport: { width: 边长, height: 边长 }, deviceScaleFactor: 1 });
  await page.setContent(
    `<style>html,body{margin:0;padding:0;background:transparent}svg{display:block;width:${边长}px;height:${边长}px}</style>${svg}`,
  );
  await page.screenshot({ path: 输出, omitBackground: true });
  await page.close();
}

rmSync(临时, { recursive: true, force: true });
const iconset = path.join(临时, "icon.iconset");
mkdirSync(iconset, { recursive: true });

for (const n of 档位) {
  await 渲染(n, path.join(iconset, `icon_${n}x${n}.png`));
  await 渲染(n * 2, path.join(iconset, `icon_${n}x${n}@2x.png`));
  console.log(`  ${n} / ${n * 2}`);
}

await 渲染(1024, path.join(出目录, "icon.png"));
console.log("  1024 → icon.png");

execFileSync("iconutil", ["-c", "icns", iconset, "-o", path.join(出目录, "icon.icns")]);
console.log("  → icon.icns");

// 小尺寸自查图：16/32/64/128 并排摆在浅灰上，一眼看出糊没糊
const 预览 = [16, 32, 64, 128];
for (const n of 预览) await 渲染(n, path.join(临时, `p${n}.png`));
const 图们 = 预览.map((n) => `<img src="p${n}.png" width="${n}" height="${n}">`).join("");
writeFileSync(
  path.join(临时, "preview.html"),
  `<style>body{margin:0;background:#eef1f5;display:flex;gap:26px;align-items:flex-end;padding:26px;font:12px -apple-system}</style>${图们}`,
);
const page = await browser.newPage({ viewport: { width: 420, height: 190 }, deviceScaleFactor: 2 });
await page.goto(`file://${path.join(临时, "preview.html")}`);
await page.screenshot({ path: path.join(出目录, "icon-preview.png") });
await page.close();
console.log("  → icon-preview.png（16/32/64/128 自查）");

await browser.close();
