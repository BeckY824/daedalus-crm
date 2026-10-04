/**
 * 发版 / 构建的几道静态守卫（回归核对 R-025 / R-026 / R-042）。
 *
 * 这几件事出错都不在本机报：.dockerignore 排掉了构建要用的目录，只有 CI 打镜像才挂；
 * ASSET_PREFIX 烤进镜像，是同一个镜像给三种人用时才出事；脚本里 $变量 后面紧跟中文，
 * 是在用户终端（不同的 locale）里才报 unbound variable。都在读文件这一层拦下。
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(__dirname, "..");
const 读 = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");

/** .dockerignore 的一行转成正则（只认这里用得到的写法：普通路径、*、**\/） */
function 忽略规则(): { 原: string; re: RegExp; 反: boolean }[] {
  return 读(".dockerignore")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const 反 = l.startsWith("!");
      const 式 = l.replace(/^!/, "").replace(/^\/+|\/+$/g, "");
      const 体 = 式
        .split(/(\*\*\/|\*)/)
        .map((x) => (x === "**/" ? "(?:.*/)?" : x === "*" ? "[^/]*" : x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")))
        .join("");
      // 匹配自己或者它下面的任何东西（排掉一个目录 = 排掉里面所有文件）
      return { 原: l, re: new RegExp(`^${体}(?:/.*)?$`), 反 };
    });
}
function 被排掉(p: string) {
  let 排 = false;
  for (const r of 忽略规则()) if (r.re.test(p)) 排 = !r.反;
  return 排;
}

describe("R-025 .dockerignore 不许排掉构建要用的文件", () => {
  it("规则本身认得对：排掉的是真该排的（防止正则写坏了整条测试变成永远绿）", () => {
    expect(被排掉("node_modules/x")).toBe(true);
    expect(被排掉("desktop/main.js")).toBe(true);
    expect(被排掉("README.md")).toBe(true);
    expect(被排掉("tests/a.test.ts")).toBe(true);
    expect(被排掉("src/app/page.tsx")).toBe(false);
  });

  it("Dockerfile 里点名用到的每个仓库文件 / 目录都进得了构建上下文", () => {
    const df = 读("Dockerfile");
    // 去掉多阶段之间的拷贝（COPY --from=… 拷的是上一阶段的产物，不是仓库文件）
    const 本体 = df
      .split("\n")
      .filter((l) => !/^\s*COPY\s+--from=/.test(l))
      .join("\n");
    const 用到 = new Set<string>();
    for (const m of 本体.matchAll(/(?<![\w/.-])((?:prisma|scripts|src|migrations|control-migrations|public|lib)\/[\w./-]*[\w-]|docker-entrypoint\.sh|package(?:-lock)?\.json|next\.config\.ts|tsconfig\.json)/g)) {
      用到.add(m[1]);
    }
    // 扫得到东西：这一版构建期要打进镜像的四个脚本都在
    for (const 该有 of ["prisma/seed.ts", "prisma/reset-data.mjs", "scripts/shared-workspace.ts", "scripts/seed-shared.ts", "docker-entrypoint.sh"]) {
      expect(用到, `Dockerfile 里没扫到 ${该有}——正则或 Dockerfile 改了`).toContain(该有);
    }
    const 坏的 = [...用到].filter((p) => fs.existsSync(path.join(ROOT, p)) && 被排掉(p));
    expect(坏的, ".dockerignore 把 Dockerfile 要用的东西排掉了：CI 打镜像必挂，本地看不见（v0.21.0 挂过一次 scripts）").toEqual([]);
  });

  it("构建里 COPY . . 之后 esbuild 打包的入口，引到的本地模块所在目录也没被排掉", () => {
    // 那次挂的就是 scripts/shared-workspace.ts 引的东西；src、prisma 是它们会引到的地方
    for (const 目录 of ["src", "prisma", "scripts", "migrations", "control-migrations", "public"]) {
      expect(被排掉(`${目录}/x`), `${目录}/ 被 .dockerignore 排掉了`).toBe(false);
    }
  });
});

describe("R-026 镜像构建不烤 ASSET_PREFIX", () => {
  it("Dockerfile 和 CI 工作流里都没有 ASSET_PREFIX：同一个镜像给托管版、自部署、桌面端三种人用", () => {
    // next.config.ts 只在构建时环境变量给了才用；谁在构建流程里设了它，所有人的静态资源就指向那一台服务器
    const 文件们 = ["Dockerfile", ...fs.readdirSync(path.join(ROOT, ".github/workflows")).map((f) => `.github/workflows/${f}`)];
    expect(文件们.length).toBeGreaterThan(2);
    const 坏的 = 文件们.filter((f) => /ASSET_PREFIX/.test(读(f)));
    expect(坏的).toEqual([]);
    // 另一头：next.config.ts 真的只在给了的时候用（不是写死一个默认地址）
    expect(读("next.config.ts")).toMatch(/process\.env\.ASSET_PREFIX\?\.trim\(\) \|\| undefined/);
  });
});

describe("R-042 shell 脚本里 $变量 后面不许紧跟中文", () => {
  it("仓库里每个 .sh 和 CI 工作流的 run 段：$V 后面紧跟非 ASCII 就要写成 ${V}", () => {
    // bash 在某些 locale 下会把紧跟着的多字节字符吞进变量名：$V（ → 变量「V（」，set -u 时 unbound variable（2026-09 gitcode.sh 在用户终端里就这么挂的）
    const sh = execFileSync("git", ["ls-files", "*.sh"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
    const 文件们 = [...sh, ...fs.readdirSync(path.join(ROOT, ".github/workflows")).map((f) => `.github/workflows/${f}`)];
    expect(sh.length, "扫不到 .sh：git ls-files 的写法改了？").toBeGreaterThanOrEqual(3);
    const 坏的: string[] = [];
    for (const f of 文件们) {
      读(f)
        .split("\n")
        .forEach((行, i) => {
          if (/^\s*#/.test(行)) return;
          if (/\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/.test(行)) 坏的.push(`${f}:${i + 1}: ${行.trim()}`);
        });
    }
    expect(坏的).toEqual([]);
  });

  it("这道守卫认得出坏写法（自检）", () => {
    expect(/\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/.test('echo "版本 $V（新）"')).toBe(true);
    expect(/\$[A-Za-z_][A-Za-z0-9_]*[^\x00-\x7F]/.test('echo "版本 ${V}（新）"')).toBe(false);
  });
});
