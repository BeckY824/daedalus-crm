/**
 * 本地开发零配置：没有 .env 就生成一个只含开发库路径的。
 * Prisma CLI 与 Next 都从项目根的 .env 读 DATABASE_URL，新克隆的仓库里没有这个文件，
 * `npm run setup` 会直接报 "Environment variable not found: DATABASE_URL"。
 * 只在文件不存在时写，绝不覆盖已有配置。
 */
import { existsSync, writeFileSync } from "node:fs";

if (!existsSync(".env")) {
  writeFileSync(".env", 'DATABASE_URL="file:./prisma/dev.db"\n');
  console.log("已生成 .env（开发库 prisma/dev.db）。AI 等可选项见 .env.example。");
}
