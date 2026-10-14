/** AI输入先校验，避免空/坏参数先显示额度错误或触发模型。 */
export function AI客户输入错误(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "请求格式不正确，请重新选择客户";
  const id = (input as Record<string, unknown>).customerId;
  return typeof id === "string" && id.trim() && id.length <= 200 ? null : "请先选择客户";
}

export function AI文本输入错误(value: unknown, min: number, max: number, short: string): string | null {
  if (typeof value !== "string") return "文本格式不正确，请重新输入";
  if (value.trim().length < min) return short;
  return value.trim().length > max ? `内容过长（超过 ${max} 字），请分段录入` : null;
}
