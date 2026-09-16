/**
 * 「哪个工作区是网页那个共享工作区」。只读环境变量，不碰数据库。
 *
 * 网页版只有一个工作区、一套固定账号密码，发给要试用的团队用。所有人看的是同一份数据——
 * 这和从前那个免登录演示区的暴露面完全一样，只是多了一道登录门。所以那套防护留着：
 * 手机号打码、隐藏 AI 接入配置。
 *
 * 单独一个文件是有原因的（原样继承自演示区那版）：(app)/layout.tsx 每个页面都要问一句
 * 「现在是不是那个共享区」。判断本身只是一次字符串比较，但它一度和灌数据的代码住在
 * 同一个模块里，于是每个页面的服务端包都被拖进一整套数据集——e2e 从 43 秒涨到 4 分钟。
 * 判断和机器要分开住。
 */
export function 共享工作区slug(): string | null {
  return process.env.SHARED_WORKSPACE?.trim() || null;
}

export function 是共享工作区(slug: string | null | undefined): boolean {
  const d = 共享工作区slug();
  return Boolean(d && slug === d);
}
