/**
 * 设置页给的那几条接入命令（2026-10-17：原来只给 Claude Code 的，Codex 一句「参数一样」——不一样，
 * 照着改 claude 那条连不上）。
 *   Claude Code：令牌直接放进 --header
 *   Codex：没有 --header，令牌从环境变量读（--bearer-token-env-var，见 openai/codex codex-rs/cli/src/mcp_cmd.rs），
 *     所以是两行：先设变量，再 add。Windows 的终端（PowerShell）不认 export，第一行换成 $env:
 */
export const MCP令牌变量 = "DAEDALUS_TOKEN";
export function MCP接入命令(地址: string, 令牌: string, 是Windows = false) {
  return {
    claude: `claude mcp add --transport http daedalus ${地址} --header "Authorization: Bearer ${令牌}"`,
    codex: [
      是Windows ? `$env:${MCP令牌变量}="${令牌}"` : `export ${MCP令牌变量}="${令牌}"`,
      `codex mcp add daedalus --url ${地址} --bearer-token-env-var ${MCP令牌变量}`,
    ],
  };
}
