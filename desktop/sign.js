/**
 * 补一次 ad-hoc 签名（免费，不需要开发者账号）。
 *
 * 不是可选项：Apple 芯片上所有可执行文件**必须**带签名才能运行，
 * 哪怕只是一个自签的空签名。electron-builder 在没有证书时不保证会补，
 * 漏掉的表现是用户双击后 macOS 报「应用已损坏，应移到废纸篓」——
 * 那句话和「未验证的开发者」完全是两回事，看到的人只会以为下载坏了。
 *
 * 签的是最终产物。通用架构（universal）构建时 electron-builder 会先分别打包
 * x64 与 arm64 再合并，中途签名会让两边文件哈希对不上导致合并失败，
 * 所以跳过临时目录——现在只出单架构包，这条留着防以后改回 universal。
 */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

/**
 * Electron 自带 55 种界面语言（Chromium 的右键菜单、文件对话框那些字），Mac 上在
 * Electron Framework 里，220 个 .lproj、44 MB。只留英文、简体、繁体中文（含 _FEMININE 这类性别变体）。
 * 系统是别的语言时 Chromium 退回英文；我们自己的界面全是中文，不受影响。
 *
 * 为什么在这里删、不用 electronLanguages：electron-builder 那个配置在 Mac 上只管
 * Contents/Resources 下的 .lproj，我们的包那里一个都没有，框架里的这 220 个它不碰。
 * Windows 那边是 locales/*.pak，用 package.json 的 win.electronLanguages 就够了。
 *
 * 必须在签名之前删：删完再整包重签，签名才对得上。
 */
const 留下的语言 = /^(en|zh_CN|zh_TW)(_(FEMININE|MASCULINE|NEUTER))?\.lproj$/;
function 裁语言包(app) {
  const dir = path.join(app, "Contents/Frameworks/Electron Framework.framework/Versions/A/Resources");
  let 删了 = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".lproj") || 留下的语言.test(name)) continue;
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    删了++;
  }
  // 删不到要吭声（Electron 换了布局就会静悄悄空转）；删过头要吭声（没了英文 Chromium 起不来）
  if (删了 === 0) throw new Error(`${dir} 里一个语言包都没删到，Electron 是不是换了目录布局`);
  for (const 必须 of ["en", "zh_CN", "zh_TW"]) {
    if (!fs.existsSync(path.join(dir, `${必须}.lproj/locale.pak`))) throw new Error(`${必须}.lproj/locale.pak 不见了`);
  }
  console.log(`  • 删掉 ${删了} 个用不到的语言包，留下 en / zh_CN / zh_TW`);
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  if (context.appOutDir.includes("-temp")) {
    console.log("  • 跳过临时架构目录，等合并后再签");
    return;
  }
  const app = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;
  裁语言包(app);
  console.log("  • ad-hoc 签名", app);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--strict", app], { stdio: "inherit" });
  console.log("  • 签名校验通过");
};
