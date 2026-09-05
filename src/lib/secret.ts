/**
 * 会话密钥的读取与校验。
 *
 * 单独放一个文件，是为了让它**能被测试直接 import**。
 * `auth.ts` 顶层引了 `next/headers`，在 vitest 里 import 会炸，
 * 于是这段逻辑一度是在测试里照抄一遍再测那个副本——
 * 那种测试在真身被改坏时照样是绿的，等于没有。
 *
 * 这里不依赖任何 Next 运行时，两边共用同一份实现。
 */

/** 生产环境要求的最小长度 */
export const 密钥最短长度 = 32;

export const 开发回落密钥 = "dev-only-secret-change-me-in-production";

/**
 * 生产环境必须显式注入 AUTH_SECRET。
 * 原本缺失时会静默回落到硬编码默认值——那意味着任何拿到这份代码的人
 * 都能伪造登录凭证，且系统照常启动、没有任何迹象。宁可起不来也不能带病运行。
 *
 * 注意 `next build` 跑的也是 NODE_ENV=production，所以构建环境同样要有值
 * （Dockerfile 的 builder 阶段给了占位串，见那里的注释）。
 */
export function readSecret(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): string {
  const s = env.AUTH_SECRET;
  if (s && s.length >= 密钥最短长度) return s;
  if (env.NODE_ENV === "production") {
    throw new Error(
      `AUTH_SECRET 未设置或长度不足 ${密钥最短长度} 位。生产环境必须注入足够强度的密钥，拒绝启动。`,
    );
  }
  return 开发回落密钥;
}
