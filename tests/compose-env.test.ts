/**
 * 代码读的每个环境变量，要么映射进了容器（docker-compose.yml / docker-compose.hosted.yml 的 environment:，
 * 或 Dockerfile 的 ENV），要么在下面「不用进容器」里写清为什么。2026-10-04 上线前测试第 0 期补的。
 *
 * 为什么要这一道：docker compose 读 .env 只做变量替换，**不写进 environment: 就进不了容器**，
 * 而且不报错——功能只是静悄悄地没了。踩过两次（umami 统计少字段、GATEWAY_* 没映射网关一直 404），
 * 排查时还点出两个更糟的可能：漏了 SHARED_WORKSPACE 共享区的手机号不打码、漏了 GATEWAY_* 所有桌面端的 AI 一起不能用
 * （回归核对 L-091 / H-079 / H-080）。e2e 起的是 dev server、直接读本机环境，测不出这一类。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");

/** 不用进容器的，各写一句为什么。新加一个变量想放这儿，先想清楚托管版上它不配会怎样 */
const 不用进容器: Record<string, string> = {
  // 桌面端壳（desktop/main.js）起本地服务时传的，托管版没有这回事
  DESKTOP_LOCAL: "桌面端壳传",
  DESKTOP_TOKEN: "桌面端壳传",
  CRM_DATA_DIR: "桌面端壳传",
  CRM_CLOUD_URL: "桌面端壳传（本机联调指到别处）",
  CRM_APP_VERSION: "桌面端壳传",
  CRM_MACHINE_HASH: "桌面端壳传",
  CLOUD_ACCOUNT: "桌面端壳传",
  // 开关 / 调试：不配就是默认行为
  AGENT_INTENTS: "调试开关，默认开",
  AGENT_TOOLCALLS: "调试开关，默认走原生工具调用",
  // 有默认值，托管版就用默认
  SYNC_DIR: "默认在 WORKSPACE_DIR 下的 sync/，跟着数据卷走",
  WORKSPACE_TEMPLATE: "默认 WORKSPACE_DIR/_template.db，entrypoint 每次启动重建",
  SMTP_PRODUCT_NAME: "邮件里的产品名，默认 Daedalus CRM",
  OPS_ALERT_ASKS_PER_HOUR: "运营提醒阈值，有默认",
  OPS_ALERT_TOKENS_PER_DAY: "运营提醒阈值，有默认",
  LLM_PRICE_IN: "运营台估成本用的单价，有默认",
  LLM_PRICE_OUT: "运营台估成本用的单价，有默认",
  MIRROR_COUNTS_URL: "官网下载数的来源，默认 ai-daedalus.com/dl/counts.json",
  GITHUB_TOKEN: "可选，只为抬高 GitHub 匿名限额",
  LEAD_ORIGINS: "官网预约表单的跨域追加来源，本地调官网时才用",
  LEAD_TO: "预约表单收件箱，缺了退到 LEGAL_CONTACT（已映射）",
  // Node / Next 自己的
  NODE_ENV: "Dockerfile 设 production",
  PORT: "Dockerfile 设 3000",
};

function* 源文件(d: string): Generator<string> {
  for (const f of readdirSync(d)) {
    if (f === "generated" || f === "node_modules") continue;
    const p = path.join(d, f);
    if (statSync(p).isDirectory()) yield* 源文件(p);
    else if (/\.(ts|tsx|mjs|js)$/.test(f)) yield p;
  }
}

/** process.env.X、process.env["X"]、以及把 process.env 传进来后的 env.X / env["X"] */
const 读法 = /(?:process\.env\.|process\.env\[["']|(?<![\w.])env\.|(?<![\w.])env\[["'])([A-Z][A-Z0-9_]+)/g;

function 代码读的(): Map<string, string> {
  const m = new Map<string, string>();
  for (const f of 源文件(path.join(ROOT, "src"))) {
    for (const x of readFileSync(f, "utf8").matchAll(读法)) if (!m.has(x[1])) m.set(x[1], path.relative(ROOT, f));
  }
  return m;
}

function compose里的(文件: string): Set<string> {
  const s = new Set<string>();
  let 在里面 = false;
  for (const 行 of readFileSync(path.join(ROOT, 文件), "utf8").split("\n")) {
    if (/^\s+environment:\s*$/.test(行)) {
      在里面 = true;
      continue;
    }
    if (在里面) {
      const k = 行.match(/^\s{6,}([A-Z][A-Z0-9_]+):/);
      if (k) s.add(k[1]);
      else if (/^\s{0,4}\S/.test(行)) 在里面 = false;
    }
  }
  return s;
}

const Dockerfile里的 = new Set(
  [...readFileSync(path.join(ROOT, "Dockerfile"), "utf8").matchAll(/^ENV\s+(.+)$/gm)].flatMap((m) => [...m[1].matchAll(/([A-Z][A-Z0-9_]+)=/g)].map((x) => x[1])),
);

describe("环境变量进得了容器", () => {
  const 读的 = 代码读的();
  const 有的 = new Set([...compose里的("docker-compose.yml"), ...compose里的("docker-compose.hosted.yml"), ...Dockerfile里的]);

  it("扫得到东西（防止正则或目录改了以后整条测试变空）", () => {
    expect(读的.size).toBeGreaterThan(30);
    expect(有的.has("GATEWAY_API_KEY") && 有的.has("SHARED_WORKSPACE") && 有的.has("MULTI_TENANT")).toBe(true);
  });

  it("代码读的每一个都映射进了容器，或者写清了为什么不用", () => {
    const 漏的 = [...读的].filter(([k]) => !有的.has(k) && !(k in 不用进容器)).map(([k, f]) => `${k}（${f}）`);
    expect(漏的, "这些变量代码在读，但 compose 的 environment: 和 Dockerfile 里都没有——在 .env 里配了也进不了容器").toEqual([]);
  });

  it("「不用进容器」里没有过期的条目", () => {
    expect(Object.keys(不用进容器).filter((k) => !读的.has(k))).toEqual([]);
  });
});
