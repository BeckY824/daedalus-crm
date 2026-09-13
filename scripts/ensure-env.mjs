/**
 * 本地开发零配置：没有 .env 就生成一个只含开发库路径的。
 * Prisma CLI 与 Next 都从项目根的 .env 读 DATABASE_URL，新克隆的仓库里没有这个文件，
 * `npm run setup` 会直接报 "Environment variable not found: DATABASE_URL"。
 * 只在文件不存在时写，绝不覆盖已有配置。
 */
import { existsSync, writeFileSync } from "node:fs";

if (!existsSync(".env")) {
  // CONTROL_DATABASE_URL 是托管版才用的库，但 `prisma generate --schema=control.prisma`
  // 不管用不用都要求这个变量存在，所以一并写上。自部署时这个文件不会被创建。
  writeFileSync(
    ".env",
    'DATABASE_URL="file:./prisma/dev.db"\nCONTROL_DATABASE_URL="file:./prisma/control.db"\n',
  );
  console.log("已生成 .env（开发库 prisma/dev.db）。AI 等可选项见 .env.example。");
}
