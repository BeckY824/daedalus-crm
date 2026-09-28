/**
 * 一次模型调用是哪个功能发起的。随请求带给网关（X-Feature 头），**只进成本账**——
 * 运营台「模型用量」按它分组，不影响任何判断。
 *
 * 网关只收这几个（会进库、会出现在运营台上，不该让客户端往里写任意字符串），
 * 发请求那边（lib/llm.ts 的 ChatOpts.feature）也只能填这几个：加一个功能只改这里。
 */
export const AI功能 = ["ask", "brief", "draft", "parse", "paste", "import", "other"] as const;
export type AI功能 = (typeof AI功能)[number];
