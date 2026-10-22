/**
 * D-24 商机 / 订单附件的测试样本（2026-10-22 质量会话备）：全部现场生成，不放真图、截图、真名片。
 * 每个文件里都埋了独有的标记词（ASCII 一段、中文一段），文件名也带标记词；上传以后拿 scope-check 的 云端明文
 * 把中转目录按字节扫一遍，标记词一个都不该搜到——内容、文件名都得是密文。
 *
 * 用法：
 *   import { 附件样本 } from "./attach-samples.mjs";
 *   const { 文件们, 标记词 } = 附件样本(目录, { 上限字节: 20 * 1024 * 1024 });
 * 命令行：node scripts/team-sim/attach-samples.mjs <目录> [上限 MB]
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";

const crc表 = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crc表[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const 块 = (类型, 数据) => {
  const 头 = Buffer.alloc(8);
  头.writeUInt32BE(数据.length, 0);
  头.write(类型, 4, "ascii");
  const 尾 = Buffer.alloc(4);
  尾.writeUInt32BE(crc32(Buffer.concat([头.subarray(4), 数据])), 0);
  return Buffer.concat([头, 数据, 尾]);
};

/** 纯色 RGB 的 PNG，带一个 tEXt 块（标记词）和一个 iTXt 块（中文标记词，utf8） */
export function 生成png(宽, 高, 标记 = "", 中文标记 = "") {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(宽, 0);
  ihdr.writeUInt32BE(高, 4);
  ihdr.writeUInt8(8, 8); // 位深
  ihdr.writeUInt8(2, 9); // RGB
  const 行 = Buffer.alloc(1 + 宽 * 3);
  for (let x = 0; x < 宽; x++) 行.set([(x * 7) & 0xff, 120, 200], 1 + x * 3);
  const 原始 = Buffer.concat(Array.from({ length: 高 }, () => 行));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    块("IHDR", ihdr),
    ...(标记 ? [块("tEXt", Buffer.from(`Comment\0${标记}`, "latin1"))] : []),
    ...(中文标记 ? [块("iTXt", Buffer.concat([Buffer.from("Description\0\0\0\0\0", "latin1"), Buffer.from(中文标记, "utf8")]))] : []),
    块("IDAT", zlib.deflateSync(原始)),
    块("IEND", Buffer.alloc(0)),
  ]);
}

/** 最小的一页 PDF，正文流不压缩，标记词原样写在里面（中文放进 /Title 的 UTF-16BE 串里） */
export function 生成pdf(标记, 中文标记 = "") {
  const 流 = `BT /F1 18 Tf 72 720 Td (${标记}) Tj ET`;
  const 标题 = 中文标记 ? `<FEFF${Buffer.from(中文标记, "utf16le").swap16().toString("hex").toUpperCase()}>` : "(sample)";
  const 对象 = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${Buffer.byteLength(流)} >>\nstream\n${流}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Title ${标题} >>`,
  ];
  let 文 = "%PDF-1.4\n";
  const 偏移 = [];
  对象.forEach((o, i) => { 偏移.push(Buffer.byteLength(文)); 文 += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(文);
  文 += `xref\n0 ${对象.length + 1}\n0000000000 65535 f \n${偏移.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}`;
  文 += `trailer\n<< /Size ${对象.length + 1} /Root 1 0 R /Info 6 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(文, "latin1");
}

/** 指定大小的文件：开头埋标记词，其余随机字节（压不小，测上限用） */
const 定长 = (字节, 标记) => {
  const b = crypto.randomBytes(字节);
  Buffer.from(标记).copy(b, 0);
  return b;
};

/**
 * 在 目录 下生成整套样本。
 * @param {string} 目录
 * @param {{ 上限字节?: number, 大图?: boolean }} [o] 上限字节：生成「正好等于上限」和「上限 + 1 字节」两个；大图：生成 6000×4000 的 PNG（约 70 MB 原始像素，压缩后小）
 * @returns {{ 文件们: { 名: string, 路径: string, 字节: number, 说明: string }[], 标记词: string[] }}
 */
export function 附件样本(目录, { 上限字节, 大图 = true } = {}) {
  fs.mkdirSync(目录, { recursive: true });
  const 批 = crypto.randomBytes(3).toString("hex").toUpperCase();
  const 标 = `D24MARK-${批}-PLAINTEXT`;
  const 中 = `附件标记${批}王总合同机密`;
  const 名标 = `王总合同-${批}`;
  const 文件们 = [];
  const 写 = (名, 内容, 说明) => {
    const 路径 = path.join(目录, 名);
    fs.writeFileSync(路径, 内容);
    文件们.push({ 名, 路径, 字节: 内容.length, 说明 });
  };
  写(`${名标}.pdf`, 生成pdf(标, 中), "PDF：正文流 ASCII 标记 + 标题 UTF-16BE 中文标记；文件名带标记");
  写(`${名标}-说明.txt`, Buffer.from(`${标}\n${中}\n`, "utf8"), "纯文本 utf8");
  写(`${名标}-utf16.txt`, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${标}\n${中}\n`, "utf16le")]), "纯文本 utf16le（带 BOM）");
  写(`${名标}-现场照.png`, 生成png(800, 600, 标, 中), "小图：tEXt / iTXt 里埋标记");
  if (大图) 写(`${名标}-大图6000.png`, 生成png(6000, 4000, 标, 中), "长边 6000：传上去应压到约 2000");
  写(`${名标}-假图片.jpg`, Buffer.from(`这其实是文本 ${标} ${中}`, "utf8"), "扩展名 .jpg、内容是文本");
  写(`${名标}-空.pdf`, Buffer.alloc(0), "0 字节");
  写(`${名标} 报价 #1 %20 😀.xlsx`, 定长(4096, 标), "文件名带空格、#、%、emoji");
  // Linux 单个文件名最多 255 字节（中文 3 字节一个），所以停在 70 多字；量排版够用
  写(`${名标}-${"很长的文件名".repeat(12)}.pdf`, 生成pdf(标), "文件名 70 多字（Windows 窄宽度量排版）");
  if (上限字节) {
    写(`${名标}-正好上限.bin`, 定长(上限字节, 标), `正好 ${上限字节} 字节：能加`);
    写(`${名标}-超1字节.bin`, 定长(上限字节 + 1, 标), `上限 + 1 字节：拒绝并写清超了多少`);
  }
  return { 文件们, 标记词: [标, 中, 名标] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [目录, 上限mb] = process.argv.slice(2);
  if (!目录) { console.error("用法：node scripts/team-sim/attach-samples.mjs <目录> [上限 MB]"); process.exit(2); }
  const r = 附件样本(目录, { 上限字节: 上限mb ? Math.round(Number(上限mb) * 1024 * 1024) : undefined });
  for (const f of r.文件们) console.log(`${String(f.字节).padStart(10)}  ${f.名}  —— ${f.说明}`);
  console.log(`标记词：${r.标记词.join("、")}`);
}
