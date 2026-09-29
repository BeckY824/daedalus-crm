const { spawn } = require("node:child_process");
const { 校验sha256 } = require("./install");

// NSIS 负责等待旧实例退出、覆盖程序、保留数据并重新启动。
// 启动前再次验哈希，避免下载后安装文件被替换。路径不经 shell。
async function 启动安装({ 文件, sha256, 启动 = spawn }) {
  if (!/^[a-f0-9]{64}$/i.test(sha256 || "")) throw new Error("Windows 更新缺少 SHA-256 校验值");
  await 校验sha256(文件, sha256);
  await new Promise((resolve, reject) => {
    const child = 启动(文件, ["/S", "--updated", "--force-run"], {
      detached: true, stdio: "ignore", windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

module.exports = { 启动安装 };
