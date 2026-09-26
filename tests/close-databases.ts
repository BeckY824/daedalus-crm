import fs from "node:fs";
import path from "node:path";
import type { PrismaClient } from "@/generated/control";

/** Windows 不能删除仍被 Prisma 打开的 SQLite 文件，清理前必须释放连接。 */
export async function closeTestDatabases(root: string) {
  const { dropWorkspaceClient } = await import("@/lib/tenant/clients");
  if (fs.existsSync(root)) {
    for (const name of fs.readdirSync(root, { recursive: true })) {
      if (String(name).endsWith(".db")) await dropWorkspaceClient(path.basename(String(name)));
    }
  }
  const shared = globalThis as unknown as { control?: PrismaClient };
  await shared.control?.$disconnect();
}
