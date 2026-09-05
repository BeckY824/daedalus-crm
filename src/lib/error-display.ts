/**
 * 错误页显示什么。
 *
 * 抽成纯函数是为了能直接测——组件里嵌着 NODE_ENV 判断的话，
 * 只能靠读源码来「验证」，那种检查在逻辑被改坏时不会红。
 */

export type 错误信息 = { message: string; digest?: string };

export type 错误展示 =
  | { 类型: "未登录" }
  | { 类型: "原文"; 文本: string }
  | { 类型: "编号"; digest?: string };

/**
 * 生产环境**不显示 error.message**：那串东西可能是数据库报错、内部字段名、
 * 文件路径，对用户没有任何帮助，对想找漏洞的人却很有用。
 * 改成显示 Next 生成的 digest——它是这次错误在服务端日志里的编号，
 * 用户把它念给管理员就能定位，本身不泄露内容。
 */
export function 决定错误展示(error: 错误信息, 开发中: boolean): 错误展示 {
  if (error.message === "UNAUTHORIZED") return { 类型: "未登录" };
  if (开发中) return { 类型: "原文", 文本: error.message };
  return { 类型: "编号", digest: error.digest };
}
