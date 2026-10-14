import { createHash } from "node:crypto";

/** 短期余额提示只用于省掉已知必失败的请求，服务端账本仍是最终裁决。 */
type Identity = { baseUrl: string; apiKey: string };
const records = new Map<string, { remaining: number; at: number; questions: Map<string, number> }>();
const TTL = 30_000;
const key = (c: Identity) => createHash("sha256").update(`${c.baseUrl.replace(/\/$/, "")}|${c.apiKey}`).digest("hex");

export function 记AI余额(c: Identity, remaining: number, questionId?: string) {
  if (!Number.isFinite(remaining) || remaining < 0) return;
  const k = key(c); const now = Date.now();
  const questions = records.get(k)?.questions ?? new Map<string, number>();
  for (const [id, at] of questions) if (now - at >= TTL) questions.delete(id);
  if (questionId) questions.set(questionId, now);
  if (questions.size > 20) questions.delete(questions.keys().next().value!);
  if (records.size >= 128 && !records.has(k)) records.clear();
  records.set(k, { remaining, at: now, questions });
}

export function 已知AI用完(c: Identity, questionId?: string): boolean {
  const entry = records.get(key(c)); const now = Date.now();
  if (!entry || entry.remaining !== 0 || now - entry.at >= TTL) return false;
  // 最后一次额度已开始的agent/分批问题仍可继续，不能半途误拦。
  return !questionId || now - (entry.questions.get(questionId) ?? 0) >= TTL;
}
