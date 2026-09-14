/**
 * 演示工作区的身份判断。只读环境变量，不碰数据库也不碰数据集。
 *
 * 单独一个文件是有原因的：(app)/layout.tsx 每个页面都要问一句「现在是不是演示区」。
 * 这个判断本身只是一次字符串比较，但它一度和 seedDemo 住在同一个模块里，
 * 于是每个页面的服务端包都被拖进了一整套灌数据的代码——e2e 整套从 43 秒涨到 4 分钟，
 * 表现是注册页的验证码提示条超时。判断和机器要分开住。
 */
export function demoSlug(): string | null {
  return process.env.DEMO_WORKSPACE?.trim() || null;
}

export function 是演示工作区(slug: string | null | undefined): boolean {
  const d = demoSlug();
  return Boolean(d && slug === d);
}
