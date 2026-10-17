/**
 * 这一阵子开始过的背调（账号:runId）。模型网关的频率闸拿它判断「这个问题编号是一次背调」，
 * 免频率闸的步数放宽到 背调最多步（api/gateway/v1/chat/completions 的 问过的 那段）。
 *
 * 放内存而不是查库：频率闸每次请求都要问一次，而它只是防失控的闸、不是收费契约——
 * 重启丢了无非是这次背调后半程多算几次频率，扣费照样在库里按 AiResearchRun 判（credits.ts 的 背调还在）。
 */
const 背调们 = new Map<string, number>();
/** 比 背调有效期（30 分钟）多留一截：快到点才开始的那一步也还认得出来 */
const 留多久 = 45 * 60_000;

/** research/start 扣费成功后记一笔 */
export function 记下背调(accountId: string, runId: string, now = Date.now()): void {
  if (背调们.size > 5000) for (const [k, t] of 背调们) if (now - t > 留多久) 背调们.delete(k);
  背调们.set(`${accountId}:${runId}`, now);
}

export function 是背调(accountId: string, runId: string, now = Date.now()): boolean {
  const t = 背调们.get(`${accountId}:${runId}`);
  return t !== undefined && now - t < 留多久;
}

/** 测试用：清空 */
export function 清空背调记录(): void {
  背调们.clear();
}
