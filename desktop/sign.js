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

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") return;
  if (context.appOutDir.includes("-temp")) {
    console.log("  • 跳过临时架构目录，等合并后再签");
    return;
  }
  const app = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;
  console.log("  • ad-hoc 签名", app);
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", app], { stdio: "inherit" });
  execFileSync("codesign", ["--verify", "--strict", app], { stdio: "inherit" });
  console.log("  • 签名校验通过");
};
