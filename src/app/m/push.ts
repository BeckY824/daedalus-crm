/**
 * 手机版推入推出（客户详情从右边推进来、退回去）的控制器（2026-10-15）。不碰 React，单测直接跑（tests/mobile-push.test.ts）。
 *
 * 之前的毛病（10-15 用户真机：两页各露一半，停在那儿不动）：
 *   - iPhone 左边缘那条「右滑返回」区一按下，motion 的拖动先把正在跑的推入动画停掉；手指没拖就松开、
 *     或者被 Safari 自己的返回手势取消（pointercancel），它只在原地补一个速度为 0 的惯性动画——就停在半路了
 *   - 收回动画被打断时，旧动画的收尾回调照样跑；同一行连点两下记两笔历史，之后按一次返回像没反应
 *   - 切后台时动画帧停了，没人兜底
 *
 * 现在：进度 p 一个数说了算（0 = 完全进来，1 = 完全退回），任何时候只有一个目标。
 * 每次动画编号，过期的收尾不生效；动画跑完、超时、切前后台、松手、手势被取消，都落到目标上，不会停在中间。
 */

export type 推入目标 = "进来" | "退回";
/** motion 的 MotionValue 用到的那几样 */
export type 推入值 = { get(): number; set(v: number): void; jump(v: number): void; stop(): void };
/** motion 的 animate() 返回的那几样 */
export type 动画句柄 = { stop(): void; then(完: () => void): unknown };

export type 推入选项 = {
  值: 推入值;
  /** 把 值 在 秒 内动到 到（调用方用 motion 的 animate + 设计系统的曲线） */
  动画: (到: number, 秒: number) => 动画句柄;
  /** 秒，调用方从设计系统的时长 token 给：整程 = 推入走满一屏；淡 = 减弱动态效果时的淡入淡出；最短 = 只差一点点时 */
  时长: { 整程: number; 淡: number; 最短: number };
  /** 完全退回之后（卸掉详情层） */
  退完: () => void;
  /** 右滑够了：走浏览器历史返回（popstate 再回到这里 去("退回")） */
  要返回: () => void;
  /** 目标变了（界面据此让正在退回的详情层不再接点击） */
  目标变了?: (目标: 推入目标) => void;
  现在?: () => number;
};

/** 松手往哪去：拖过三分之一，或者往右甩得够快，就退回 */
export function 松手去向(p: number, 速度: number): 推入目标 {
  return p > 1 / 3 || 速度 > 600 ? "退回" : "进来";
}

/**
 * 进度 p → 两层的样子。iOS：上一页往左退 30%、盖一层暗；安卓：新页从右边一小段淡入；
 * 减弱动态效果：都不位移，只淡入淡出
 */
export function 层样子(p: number, 宽: number, os: "ios" | "android", 少动: boolean) {
  const q = Math.min(1, Math.max(0, p));
  if (少动) return { 顶x: 0, 顶透明: 1 - q, 底x: 0, 暗: 0 };
  if (os === "android") return { 顶x: q * 宽 * 0.18, 顶透明: 1 - q, 底x: 0, 暗: 0 };
  return { 顶x: q * 宽, 顶透明: 1, 底x: (q - 1) * 宽 * 0.3, 暗: (1 - q) * 0.12 };
}

type 拖着 = { x0: number; p0: number; 动了: boolean; 样: { x: number; t: number }[] };

export class 推入 {
  目标: 推入目标 = "退回";
  /** 屏宽、减弱动态效果：界面每次渲染后用 设() 更新 */
  宽 = 390;
  少动 = false;
  设(宽: number, 少动: boolean) { this.宽 = 宽; this.少动 = 少动; }
  private 号 = 0;
  private 当前: 动画句柄 | null = null;
  private 兜底: ReturnType<typeof setTimeout> | null = null;
  private 拖: 拖着 | null = null;
  constructor(private o: 推入选项) {}

  get 在动() { return !!this.当前; }
  get 在拖() { return !!this.拖; }

  /** 往目标去。已经在往那儿去了就不重来（popstate 和手势可能先后各叫一次） */
  去(目标: 推入目标) {
    if (目标 === this.目标 && this.当前 && !this.拖) return;
    this.拖 = null;
    this.定目标(目标);
    const 号 = ++this.号;
    this.停();
    const 到 = 目标 === "进来" ? 0 : 1;
    const 剩 = Math.abs(到 - this.o.值.get());
    if (剩 < 0.001) return this.落定(号);
    const { 整程, 淡, 最短 } = this.o.时长;
    const 秒 = Math.max(最短, (this.少动 ? 淡 : 整程) * 剩);
    this.当前 = this.o.动画(到, 秒);
    this.当前.then(() => this.落定(号));
    // 动画帧停了（切后台、页面冻住）也要落位：多给 400ms，到点还没完就直接放到目标
    this.兜底 = setTimeout(() => this.落定(号), 秒 * 1000 + 400);
  }

  /** 马上落到目标（切前后台、页面恢复时）。没在动就什么都不做 */
  收尾() {
    if (this.当前 && !this.拖) this.落定(this.号);
  }

  /** 登录失效、退出：不动画，直接回到「没有详情」 */
  复位() {
    this.号++;
    this.停();
    this.拖 = null;
    this.定目标("退回");
    this.o.值.jump(1);
  }

  /* ---------- 左边缘右滑返回（只有 iPhone 有） ---------- */

  按下(x: number) {
    if (this.目标 !== "进来") return;
    this.号++;
    this.停();
    const t = this.现在();
    this.拖 = { x0: x, p0: this.o.值.get(), 动了: false, 样: [{ x, t }] };
  }

  移动(x: number) {
    const d = this.拖;
    if (!d) return;
    const dx = x - d.x0;
    if (!d.动了 && Math.abs(dx) < 4) return;
    d.动了 = true;
    this.o.值.set(Math.min(1, Math.max(0, d.p0 + dx / this.宽)));
    const t = this.现在();
    d.样.push({ x, t });
    while (d.样.length > 2 && t - d.样[0].t > 100) d.样.shift();
  }

  /** 松手：没拖动就接着往原目标走（之前就是这里停在半路）；拖了按距离和速度决定 */
  松手(x: number) {
    const d = this.拖;
    if (!d) return;
    this.移动(x);
    this.拖 = null;
    if (!d.动了) return this.接着走();
    const 首 = d.样[0], 末 = d.样[d.样.length - 1];
    const 速度 = 末.t > 首.t ? ((末.x - 首.x) / (末.t - 首.t)) * 1000 : 0;
    if (松手去向(this.o.值.get(), 速度) === "退回") {
      this.去("退回");
      this.o.要返回();
    } else this.去("进来");
  }

  /**
   * 手势被系统取消（Safari 自己的边缘返回手势接管了、来电话了）：不替它走历史返回——
   * 真退了会有 popstate 叫 去("退回")；没退就回到原目标
   */
  取消() {
    if (!this.拖) return;
    this.拖 = null;
    this.接着走();
  }

  /** 按下时已经把动画停了（当前为空），去() 不会当成「已经在往那儿去了」 */
  private 接着走() {
    this.去(this.目标);
  }

  private 落定(号: number) {
    if (号 !== this.号) return;
    // 先作废这个编号：停动画时 motion 可能马上回调 then，不能再落一次（会卸两次详情层）
    this.号++;
    this.停();
    this.o.值.jump(this.目标 === "进来" ? 0 : 1);
    if (this.目标 === "退回") this.o.退完();
  }

  private 定目标(目标: 推入目标) {
    if (目标 === this.目标) return;
    this.目标 = 目标;
    this.o.目标变了?.(目标);
  }

  private 停() {
    if (this.兜底) clearTimeout(this.兜底);
    this.兜底 = null;
    const a = this.当前;
    this.当前 = null;
    a?.stop();
    this.o.值.stop();
  }

  private 现在() { return this.o.现在?.() ?? performance.now(); }
}
