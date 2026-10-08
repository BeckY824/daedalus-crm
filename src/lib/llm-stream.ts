/** OpenAI SSE状态；按行处理跨chunk事件，不把正常EOF误认为完整回答。 */
export class CompletionStream {
  private buffer = "";
  text = "";
  done = false;
  private finished = false;
  private truncated = false;
  get complete() { return (this.done || this.finished) && !this.truncated; }
  hasContent = false;
  usage: unknown;
  constructor(private onToken: (text: string) => void = () => {}) {}
  push(chunk: string) {
    this.buffer += chunk;
    if (this.buffer.length > 2_000_000) throw new Error("AI响应事件过长");
    let i: number;
    while ((i = this.buffer.indexOf("\n")) !== -1) {
      this.line(this.buffer.slice(0, i)); this.buffer = this.buffer.slice(i + 1);
    }
  }
  finish() { if (this.buffer.trim()) this.line(this.buffer); this.buffer = ""; }
  private line(line: string) {
    if (this.done || !line.trim().startsWith("data:")) return;
    const payload = line.trim().slice(5).trim();
    if (payload === "[DONE]") { this.done = true; return; }
    let data;
    try { data = JSON.parse(payload); } catch { return; }
    if (data?.usage) this.usage = data;
    if (["stop", "tool_calls", "function_call"].includes(data?.choices?.[0]?.finish_reason)) this.finished = true;
    if (data?.choices?.[0]?.finish_reason === "length") this.truncated = true;
    const delta = data?.choices?.[0]?.delta;
    if (typeof delta?.content === "string" && delta.content) {
      this.text += delta.content; this.hasContent = true;
      if (this.text.length > 4_000_000) throw new Error("AI回答过长");
      this.onToken(delta.content);
    }
    if (Array.isArray(delta?.tool_calls) && delta.tool_calls.length) this.hasContent = true;
  }
}
