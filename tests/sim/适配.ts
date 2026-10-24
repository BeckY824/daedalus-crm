/**
 * 企业版接口的适配：main 上没有这些模块，静态 import 会让整个测试文件在 main 上加载失败。
 * 这里按路径动态载入（@vite-ignore），模块或导出不在就抛「未实现：X（第四节 D-xx）」——
 * 检查点照常生成、照常记红，不会因为少一个文件整组不跑。
 */
import fs from "node:fs";
import path from "node:path";

const 源 = path.resolve(__dirname, "../../src");

/** 这几个文件都在才跑「开关开」那组（main 上只有 switch.ts） */
export const 企业版文件 = [
  "lib/enterprise/visibility.ts",
  "lib/enterprise/rules.ts",
  "lib/project/org-rules-store.ts",
  "app/(app)/leads/assign-actions.ts",
];
export const 企业版都在 = 企业版文件.every((f) => fs.existsSync(path.join(源, f)));

const 缓存 = new Map<string, Record<string, unknown>>();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function 载入(模块: string): Promise<Record<string, any> | null> {
  if (缓存.has(模块)) return 缓存.get(模块)!;
  const 文件 = [".ts", ".tsx"].map((x) => path.join(源, 模块 + x)).find((f) => fs.existsSync(f));
  if (!文件) return null;
  const m = (await import(/* @vite-ignore */ 文件)) as Record<string, unknown>;
  缓存.set(模块, m);
  return m;
}

/** 拿一个导出；没有就抛「未实现」，检查点记红 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function 要<T = (...a: any[]) => any>(模块: string, 名: string, 规则: string): Promise<T> {
  const m = await 载入(模块);
  const f = m?.[名];
  if (f === undefined) throw new Error(`未实现：${模块} 的「${名}」（第四节 ${规则}）`);
  return f as T;
}

/** 可选导出：有就用，没有返回 null（不记红，比如只用来清缓存的） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function 可有<T = (...a: any[]) => any>(模块: string, 名: string): Promise<T | null> {
  return ((await 载入(模块))?.[名] as T | undefined) ?? null;
}
