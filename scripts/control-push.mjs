/**
 * npm run control:push 的门卫（2026-10-04，回归核对 H-077）。
 *
 * prisma db push 会把库「推」成 control.prisma 的样子：schema 里没有的表（ActivationCode 等老码表线上还留着）会被删，
 * 对着线上控制面跑一次，账号、次数账本、同步密文的索引都在里面。线上改结构只许走 control-migrations/（只加表）。
 * 所以这里只放行本机开发库：路径在仓库目录或系统临时目录下，且不是 /data/ 开头。
 */
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 只认 file: 开头的 SQLite 地址；相对路径照 prisma 的规矩按 schema 所在目录（prisma/）解析 */
export function 是本机开发库(url, root = ROOT, tmp = os.tmpdir()) {
  if (!url || !url.startsWith("file:")) return false;
  const 路径 = url.slice(5);
  const 绝对 = path.resolve(path.join(root, "prisma"), 路径);
  if (绝对.startsWith("/data/")) return false;
  const 在里面 = (父) => {
    const r = path.relative(path.resolve(父), 绝对);
    return r && !r.startsWith("..") && !path.isAbsolute(r);
  };
  return 在里面(root) || 在里面(tmp) || 在里面("/tmp") || 在里面("/private/tmp");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const url = process.env.CONTROL_DATABASE_URL;
  if (!是本机开发库(url)) {
    console.error(`拒绝：CONTROL_DATABASE_URL=${url ?? "（没设）"} 不是本机开发库。\n线上控制面只许走 control-migrations/（只加表），不许 db push——它会删掉 schema 里没有的表。`);
    process.exit(1);
  }
  execFileSync(process.execPath, [path.join(ROOT, "node_modules/prisma/build/index.js"), "db", "push", "--schema=prisma/control.prisma", ...process.argv.slice(2)], { stdio: "inherit", cwd: ROOT });
}
