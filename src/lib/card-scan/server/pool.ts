/**
 * 服务器认名片的线程池 + 排队（2026-10-20，用户同意「服务器识别为主、本机识别兜底」）。
 *
 *   - 同一时间最多认 线程数 张（每个线程一张），其余排队；排着的每变一次位置就告诉手机「前面还有 x 张」
 *   - 排太久（默认 20 秒）、排的太多（默认 30 张）就不排了，回「太忙」，手机改用本机识别
 *   - 线程懒起：第一次有人扫才起；闲 10 分钟全关掉，把内存还给同机的别的服务（Luxe Ops）
 *   - 一张认太久（30 秒）或线程挂了：这张报错（手机改用本机），线程重起
 *
 * 线程数按本机 docker --cpus=2 --memory=2g 实测定（见 PR），环境变量 OCR_WORKERS 可改。
 * 照片只在内存里传给线程，认完就丢，不落盘、不打日志
 */
import { Worker } from "node:worker_threads";
import path from "node:path";

export type 识别项 = { poly: unknown; text: string; score: number };

/** 排的太多 / 排太久：不是坏了，手机改用本机识别 */
export class 太忙 extends Error {
  constructor(话: string) {
    super(话);
    this.name = "太忙";
  }
}

export type 池设置 = {
  线程数: number;
  最多排: number;
  等太久毫秒: number;
  认太久毫秒: number;
  闲多久关毫秒: number;
  worker路径: string;
  模型目录: string;
};

const 正整数 = (v: string | undefined, 缺省: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : 缺省;
};

export const 默认池设置 = (): 池设置 => ({
  线程数: 正整数(process.env.OCR_WORKERS, 1),
  最多排: 正整数(process.env.OCR_QUEUE_MAX, 30),
  等太久毫秒: 正整数(process.env.OCR_QUEUE_WAIT_MS, 20_000),
  认太久毫秒: 30_000,
  闲多久关毫秒: 10 * 60_000,
  worker路径: path.join(process.cwd(), "ocr-server/worker.mjs"),
  模型目录: path.join(process.cwd(), "public/ocr/v1/models"),
});

type 活 = {
  id: number;
  模型: string;
  图: Uint8Array;
  进: (前面: number) => void;
  ok: (items: 识别项[]) => void;
  no: (e: Error) => void;
  计时?: ReturnType<typeof setTimeout>;
  撤?: () => void;
};
type 线程 = { w: Worker; 在认: 活 | null; 计时?: ReturnType<typeof setTimeout> };

export type 识别池 = ReturnType<typeof 建池>;

export function 建池(设: Partial<池设置> = {}) {
  const 配 = { ...默认池设置(), ...设 };
  const 线程们: 线程[] = [];
  const 队: 活[] = [];
  let 下个 = 0;
  let 闲表: ReturnType<typeof setTimeout> | null = null;

  function 起线程(): 线程 {
    const w = new Worker(配.worker路径, { workerData: { 模型目录: 配.模型目录 } });
    const t: 线程 = { w, 在认: null };
    w.on("message", (m: { id: number; items?: 识别项[]; 错?: string }) => {
      const a = t.在认;
      if (!a || m.id !== a.id) return;
      clearTimeout(t.计时);
      t.在认 = null;
      if (m.错 !== undefined) a.no(new Error(m.错));
      else a.ok(m.items ?? []);
      派();
    });
    w.on("error", (e) => 坏了(t, e));
    w.on("exit", (code) => 坏了(t, new Error(`识别线程退出（${code}）`)));
    // 先把中英那台载好：第一张不用等加载模型
    w.postMessage({ 预热: true });
    return t;
  }

  function 坏了(t: 线程, e: Error) {
    const i = 线程们.indexOf(t);
    if (i < 0) return;
    线程们.splice(i, 1);
    clearTimeout(t.计时);
    void t.w.terminate();
    const a = t.在认;
    t.在认 = null;
    a?.no(e);
    派();
  }

  /** 报位置：前面 = 正在认的 + 排在前面的（轮到自己时报 0） */
  function 报位置() {
    const 在认 = 线程们.filter((t) => t.在认).length;
    队.forEach((a, i) => a.进(在认 + i));
  }

  function 定闲() {
    if (闲表) clearTimeout(闲表);
    闲表 = null;
    if (!线程们.length || 队.length || 线程们.some((t) => t.在认)) return;
    闲表 = setTimeout(() => {
      for (const t of 线程们.splice(0)) void t.w.terminate();
    }, 配.闲多久关毫秒);
    闲表.unref?.();
  }

  function 派() {
    // 懒起：排着的比闲着的线程多、还没到上限，就多起一个
    while (队.length > 线程们.filter((t) => !t.在认).length && 线程们.length < 配.线程数) 线程们.push(起线程());
    for (const t of 线程们) {
      if (t.在认 || !队.length) continue;
      const a = 队.shift()!;
      clearTimeout(a.计时);
      a.撤?.();
      t.在认 = a;
      a.进(0);
      t.计时 = setTimeout(() => 坏了(t, new Error("识别超时")), 配.认太久毫秒);
      t.w.postMessage({ id: a.id, 模型: a.模型, 图: a.图 });
    }
    报位置();
    定闲();
  }

  function 出队(a: 活): boolean {
    const i = 队.indexOf(a);
    if (i < 0) return false;
    队.splice(i, 1);
    clearTimeout(a.计时);
    a.撤?.();
    报位置();
    定闲();
    return true;
  }

  return {
    /** 认一张（图 = 手机压好的 JPEG）。排不上 / 排太久抛 太忙；signal 断了（手机走了）就从队里撤掉 */
    认(图: Uint8Array, 模型: string, o: { signal?: AbortSignal; 进?: (前面: number) => void } = {}): Promise<识别项[]> {
      if (o.signal?.aborted) return Promise.reject(new Error("取消了"));
      if (队.length >= 配.最多排) return Promise.reject(new 太忙("排队的太多"));
      return new Promise<识别项[]>((ok, no) => {
        const a: 活 = { id: ++下个, 模型, 图, 进: o.进 ?? (() => undefined), ok, no };
        a.计时 = setTimeout(() => { if (出队(a)) no(new 太忙("排队太久")); }, 配.等太久毫秒);
        if (o.signal) {
          const 撤 = () => { if (出队(a)) no(new Error("取消了")); };
          o.signal.addEventListener("abort", 撤, { once: true });
          a.撤 = () => o.signal!.removeEventListener("abort", 撤);
        }
        队.push(a);
        派();
      });
    },
    /** 手机打开扫名片时先叫一声：一个线程都没有就起一个，载好中英那台 */
    预热() {
      if (!线程们.length) { 线程们.push(起线程()); 定闲(); }
    },
    状态: () => ({ 线程: 线程们.length, 在认: 线程们.filter((t) => t.在认).length, 排队: 队.length }),
    async 关() {
      for (const a of 队.splice(0)) { clearTimeout(a.计时); a.撤?.(); a.no(new Error("服务关了")); }
      if (闲表) clearTimeout(闲表);
      await Promise.all(线程们.splice(0).map((t) => t.w.terminate()));
    },
  };
}

/** 整个服务一个池（开发时热更新会重载模块，挂在 globalThis 上免得起一堆线程） */
export function 取识别池(): 识别池 {
  const g = globalThis as { __名片识别池?: 识别池 };
  return (g.__名片识别池 ??= 建池());
}
