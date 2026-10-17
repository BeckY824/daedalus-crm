/**
 * 设置页给的那几条接入命令（2026-10-17：原来只给 Claude Code 的，Codex 一句「参数一样」——不一样，
 * 照着改 claude 那条连不上）。
 *   Claude Code：令牌直接放进 --header
 *   Codex：没有 --header，令牌从环境变量读（--bearer-token-env-var，见 openai/codex codex-rs/cli/src/mcp_cmd.rs），
 *     所以是两行：先设变量，再 add。Windows 的终端（PowerShell）不认 export，第一行换成 $env:
 *   Codex 桌面应用（ChatGPT.app 里那个，不开终端的人）：变量要设在启动应用的环境里，普通人做不到；
 *     给一段 config.toml，令牌直接写进 http_headers，不靠变量（2026-10-17 用 Codex CLI 0.162 实测：
 *     不设变量、只靠 http_headers 能直接调到工具）
 */
export const MCP令牌变量 = "DAEDALUS_TOKEN";
export function MCP接入命令(地址: string, 令牌: string, 是Windows = false) {
  return {
    claude: `claude mcp add --transport http daedalus ${地址} --header "Authorization: Bearer ${令牌}"`,
    codex: [
      是Windows ? `$env:${MCP令牌变量}="${令牌}"` : `export ${MCP令牌变量}="${令牌}"`,
      `codex mcp add daedalus --url ${地址} --bearer-token-env-var ${MCP令牌变量}`,
    ],
    codex配置: `[mcp_servers.daedalus]\nurl = "${地址}"\nhttp_headers = { Authorization = "Bearer ${令牌}" }`,
  };
}
