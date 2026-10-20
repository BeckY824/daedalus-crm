/**
 * 扫名片识别文件的下载（2026-10-20）：用户在伦敦第一次用，提示「识别模型没下载下来」。
 * 原来是 SDK 自己一个接一个地下（主文件 → worker → 模型 → wasm），服务器在香港，一串要三分钟，
 * 中途断一次就整个失败、看不到进度、没有重试（模拟器限速 100 KB/s 复现：掐断连接 → 正好是这句话）。
 *
 * 现在先自己把这一串下齐，再让 SDK 去载（同一个地址，浏览器从 HTTP 缓存里拿，/ocr/ 一年不过期）：
 *   - 几个文件同时下，按线上要传的字节报进度
 *   - 断了 / 卡住（30 秒一个字节都没来）自动重试；下完的文件在缓存里，重试不会再下
 *   - 页面不在前台时断的（锁屏、切走、相机盖着）：不在后台空转重试，报「下载被中断」，回来再点一次接着下
 */

/** 要下的一个文件：原 = 解压后多少字节（读到的就是这个），传 = 线上大概传多少（预压缩后的大小，进度按它算） */
export type 要下的 = { url: string; 原: number; 传: number };

export const 下载中断的话 = "下载被中断，保持在这个页面再点一次";

/** 页面不在前台时断了：不是网的问题，回到页面再点一次就接着下 */
export class 下载中断 extends Error {
  constructor() {
    super(下载中断的话);
    this.name = "下载中断";
  }
}

type 文档 = Pick<Document, "hidden">;

export type 下载设置 = {
  /** 已 / 总：按「传」算的字节 */
  进?: (已: number, 总: number) => void;
  并发?: number;
  /** 一次都没下到东西的失败，最多连着几次就放弃（下到了东西的不算，接着试） */
  空手次数?: number;
  /** 这么久一个字节都没来就当断了 */
  卡住毫秒?: number;
  /** 测试用 */
  抓?: typeof fetch;
  歇?: (ms: number) => Promise<void>;
  文档?: 文档;
};

const 默认歇 = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

/** 把这些文件都下到浏览器缓存里。失败抛错：页面在后台时断的抛 下载中断，其余的抛带 network 字样的错 */
export async function 下载齐(文件们: 要下的[], 设: 下载设置 = {}): Promise<void> {
  const { 进, 并发 = 3, 空手次数 = 4, 卡住毫秒 = 30_000, 抓 = fetch, 歇 = 默认歇 } = 设;
  const 档 = 设.文档 ?? (typeof document === "undefined" ? undefined : document);
  const 总 = 文件们.reduce((s, f) => s + f.传, 0);
  const 已 = 文件们.map(() => 0);
  const 报 = () => 进?.(Math.round(已.reduce((s, x) => s + x, 0)), 总);
  const 停 = new AbortController();
  let 坏: unknown = null;
  报();

  const 下一个 = (() => { let i = 0; return () => (i < 文件们.length ? i++ : -1); })();

  async function 下一份(i: number): Promise<void> {
    const f = 文件们[i];
    let 空手 = 0;
    for (;;) {
      if (停.signal.aborted) return;
      const 这次 = new AbortController();
      const 撤 = () => 这次.abort();
      停.signal.addEventListener("abort", 撤);
      let 读到 = 0, 卡住了 = false;
      let 表 = setTimeout(() => { 卡住了 = true; 这次.abort(); }, 卡住毫秒);
      const 动了 = () => { clearTimeout(表); 表 = setTimeout(() => { 卡住了 = true; 这次.abort(); }, 卡住毫秒); };
      try {
        const r = await 抓(f.url, { signal: 这次.signal });
        // 4xx 重试也没用（文件不在），直接报；5xx 当网络问题重试
        if (!r.ok) {
          const e = new Error(`识别文件下载失败 ${r.status}：${f.url}`);
          if (r.status < 500) throw Object.assign(e, { 不重试: true });
          throw e;
        }
        if (r.body) {
          const 读 = r.body.getReader();
          for (;;) {
            const { done, value } = await 读.read();
            if (done) break;
            动了();
            读到 += value.byteLength;
            已[i] = Math.min(读到 / f.原, 1) * f.传;
            报();
          }
        } else {
          await r.arrayBuffer();
        }
        已[i] = f.传;
        报();
        return;
      } catch (e) {
        if (停.signal.aborted) return;
        if ((e as { 不重试?: boolean }).不重试) throw e;
        已[i] = 0;
        报();
        // 不在前台：锁屏、切走、相机盖着。不在后台空转，等人回来再点
        if (档?.hidden) throw new 下载中断();
        if (读到 === 0 && ++空手 >= 空手次数) {
          throw new Error(`network: 识别文件下不下来（${卡住了 ? "卡住了" : e instanceof Error ? e.message : String(e)}）`);
        }
        if (读到 > 0) 空手 = 0;
        await 歇(Math.min(1000 * 2 ** 空手, 8000));
        if (档?.hidden) throw new 下载中断();
      } finally {
        clearTimeout(表);
        停.signal.removeEventListener("abort", 撤);
      }
    }
  }

  async function 干活(): Promise<void> {
    for (let i = 下一个(); i >= 0 && !停.signal.aborted; i = 下一个()) {
      try {
        await 下一份(i);
      } catch (e) {
        if (!坏) 坏 = e;
        停.abort();
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(并发, 文件们.length) }, 干活));
  if (坏) throw 坏;
}

/**
 * 认名片抛出来的错 → 给人看的话。下载中断 / 网络问题都能「再试一次」（同一张照片接着下，下完的不重下）。
 * Chrome 是 Failed to fetch（dynamically imported module），Safari 是 Load failed / Importing a module script failed
 */
export function 错的话(e: unknown): { 话: string; 能重试: boolean } {
  const 话 = e instanceof Error ? e.message : String(e);
  if (e instanceof 下载中断 || (e instanceof Error && e.name === "下载中断")) return { 话: 下载中断的话, 能重试: true };
  if (/fetch|network|Failed to load|Load failed|import/i.test(话)) return { 话: "识别模型没下载下来：网络不稳，点「再试一次」接着下（下完的不用重下）", 能重试: true };
  return { 话: `没认出来：${话}`, 能重试: false };
}
