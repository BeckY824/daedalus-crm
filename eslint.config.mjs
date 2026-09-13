import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Prisma 生成的客户端代码，不参与 lint
    "src/generated/**",
    // 桌面客户端是独立的 Electron 包：主进程必须走 CommonJS，
    // 用 Next 这套规则去 lint 它只会得到一堆「不许 require」的假阳性
    "desktop/**",
  ]),
]);

export default eslintConfig;
