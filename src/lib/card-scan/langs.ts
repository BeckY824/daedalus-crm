/**
 * 名片语言 → 识别模型（手机上本机认、服务器上认共用一张表；2026-10-20 服务器识别从 ocr.ts 挪出来，服务端不碰浏览器那套代码）。
 * MB = 这种语言的识别模型包第一次在手机上下多大（中英那套的大小按 manifest 算）
 */
export type 名片语言 = "中英" | "日" | "韩" | "阿拉伯" | "泰" | "西里尔" | "天城";
export const 名片语言们: { k: 名片语言; 叫: string; 模型: string; MB: number }[] = [
  { k: "中英", 叫: "中英", 模型: "PP-OCRv6_tiny", MB: 0 },
  { k: "日", 叫: "日文", 模型: "PP-OCRv6_small", MB: 19 },
  { k: "韩", 叫: "韩文", 模型: "korean_PP-OCRv5_mobile", MB: 8 },
  { k: "阿拉伯", 叫: "阿拉伯文", 模型: "arabic_PP-OCRv5_mobile", MB: 7 },
  { k: "泰", 叫: "泰文", 模型: "th_PP-OCRv5_mobile", MB: 7 },
  { k: "西里尔", 叫: "俄文", 模型: "cyrillic_PP-OCRv5_mobile", MB: 7 },
  { k: "天城", 叫: "印地文", 模型: "devanagari_PP-OCRv5_mobile", MB: 7 },
];
export const 语言表 = Object.fromEntries(名片语言们.map((x) => [x.k, x])) as Record<名片语言, (typeof 名片语言们)[number]>;
export const 是名片语言 = (x: unknown): x is 名片语言 => typeof x === "string" && Object.hasOwn(语言表, x);
