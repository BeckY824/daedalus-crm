/**
 * 商机 / 订单附件的规矩（2026-10-22 D-24）：上限、哪些算图片、大小怎么写给人看。服务端和界面共用，不碰 node。
 */

/**
 * 单个附件的上限。团队版那边测完存储量后总控会给一个数，**只改这一处**（服务端拒收、界面提示都读它）
 */
export const 附件上限字节 = 20 * 1024 * 1024;

/** 图片在本机压到长边这么多像素再存（用户 10-22：「压到长边约 2000 像素」） */
export const 图片长边 = 2000;

/** 一个商机 / 订单下最多挂几个：防拖进一整个文件夹 */
export const 每条最多 = 100;

/** 浏览器能直接显示、按图片对待（缩略图、点开看大图）。SVG 不算：里面能带脚本 */
const 图片类型 = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp"]);
export function 是图片(mime: string): boolean {
  return 图片类型.has(mime.toLowerCase());
}

/**
 * 这一版只收图片（用户 10-22：商机、订单的产品图片；合同、方案、图纸这类文件先不做）。
 * 通用附件的存取都还在，放开别的类型只要改这里 + 界面上的 accept
 */
export const 只收图片 = true;
export const 收的类型 = [...图片类型].join(",");
export function 不收说明(名字: string, mime: string): string | null {
  if (!只收图片 || 是图片(mime)) return null;
  return `「${名字}」不是图片，这里只收 JPG、PNG、GIF、WebP、BMP 图片`;
}

/** 能在本机压的：GIF 不压（动图压了就不动了） */
export function 可以压(mime: string): boolean {
  return 是图片(mime) && mime.toLowerCase() !== "image/gif";
}

/**
 * 这张图要不要在这台电脑上重画一遍：长边超了要缩；JPEG / WebP / BMP 不超也重画——
 * 手机拍的照片 EXIF 里带拍摄地点（GPS）、相机型号，重画以后就没了。PNG 不超就原样（多是截图、图标，重画只会变大）
 */
export function 要重画(mime: string, 宽: number, 高: number): boolean {
  if (!可以压(mime)) return false;
  return Math.max(宽, 高) > 图片长边 || mime.toLowerCase() !== "image/png";
}

/** 1.2 MB / 340 KB / 12 字节 */
export function 读大小(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1).replace(/\.0$/, "")} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} 字节`;
}

/** 超了就说清超了多少；没超 = null */
export function 超限说明(名字: string, 大小: number, 上限 = 附件上限字节): string | null {
  if (大小 <= 上限) return null;
  return `「${名字}」有 ${读大小(大小)}，超了 ${读大小(大小 - 上限)}（单张最多 ${读大小(上限)}）`;
}

/** 文件名收拾一下：去掉路径、控制字符，最长 120 个字 */
export function 规整文件名(名: string): string {
  const 去路径 = 名.split(/[\\/]/).pop() ?? "";
  const 干净 = 去路径.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (干净 || "附件").slice(0, 120);
}

/** 压成 JPEG 以后扩展名跟着换 */
export function 换成jpg(名: string): string {
  const i = 名.lastIndexOf(".");
  return (i > 0 ? 名.slice(0, i) : 名) + ".jpg";
}

/** 附件编号：cuid，只许字母数字（拼文件路径、IPC 都靠它挡 ../） */
export function 是附件编号(id: unknown): id is string {
  return typeof id === "string" && /^[a-z0-9]{8,40}$/i.test(id);
}

export type 附件 = {
  id: string;
  name: string;
  mime: string;
  size: number;
  width: number | null;
  height: number | null;
  createdAt: string;
  /** 文件在不在这台电脑上（团队版以后：行同步过来了、文件还没下载） */
  有文件: boolean;
};

export type 归属 = { opportunityId: string } | { orderId: string };
