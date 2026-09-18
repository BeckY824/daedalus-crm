import fs from "node:fs";
import path from "node:path";

/**
 * 别人的 agent 该往哪个地址连。
 *
 * 桌面端的本地服务每次启动换一个随机端口，所以壳里另开了一条固定端口的薄桥
 * （desktop/mcp-bridge.js），它把自己实际落在哪个端口写进数据目录的 `mcp.json`。
 * 有那个文件就用它——**那个地址跨重启有效**，才配写进别人的配置文件。
 *
 * 没有（自部署的网页版、或者桥没开起来）就退回本进程这个端口：
 * 自部署那边端口本来就是固定的，退回去也是对的。
 */
export function MCP地址(): string {
  const dir = process.env.CRM_DATA_DIR;
  if (dir) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, "mcp.json"), "utf8")) as { url?: unknown };
      if (typeof j.url === "string" && j.url.startsWith("http")) return j.url;
    } catch {
      // 没有这个文件是常态（网页版、旧版本的壳），不是错
    }
  }
  return `http://127.0.0.1:${process.env.PORT || "3000"}/api/mcp`;
}
