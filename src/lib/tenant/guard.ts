
/**
 * 试用 / 订阅到期后把写操作拦住。
 *
 * 为什么不靠前端隐藏按钮：按钮只是提示，Server Action 是公开的 HTTP 端点，
 * 到期后照样能被直接调用。真正的闸门必须在服务端，而且要在离数据最近的地方。
 *
 * 只读不拦：人得能把自己的数据看完、导出、决定要不要付费。
 * 到期就锁死数据是把客户变成人质，不做。
 */
export class TrialExpiredError extends Error {
  constructor() {
    super("试用已结束，数据可以继续查看和导出，恢复编辑请开通订阅");
    this.name = "TrialExpiredError";
  }
}
