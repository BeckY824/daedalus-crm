#!/usr/bin/env python3
"""
生成企业版的手机号归属地离线表 src/lib/enterprise/phone-region-data.ts（2026-10-26，测试清单 B7）。

私有部署可能不能联网，归属地得随包带着。数据取自 phone2region 0.0.3（MIT，npm）里的 phone.dat
（上游 pangongzi/phone，数据版本 2502 = 2025-02；文件格式沿用 xluohome/phonedata）。
不把那个包装进依赖：它 4.7MB、查询代码有毛病，我们只要「前 7 位 → 省市 + 运营商」这一张表。

用法（只读数据、不跑包里的代码）：
  python3 -I scripts/make-phone-region.py <phone.dat 路径>

phone.dat 格式：4 字节版本号 + int32 LE 索引起点；记录区是「省|市|邮编|区号\\0」；
索引区每条 9 字节 = int32 前 7 位 + int32 记录偏移 + int8 运营商。

输出：城市表（省|市）+ 一串游程（前 7 位从 1300000 起连续，每段 = varint 段长 + uint16 值，
值 = 城市序号 * 8 + 运营商，0xFFFF = 这段没有数据），deflate 后 base64。
"""
import base64, struct, sys, zlib, os

src = sys.argv[1]
buf = open(src, "rb").read()
版本 = buf[:4].decode("ascii")
索引起 = struct.unpack_from("<i", buf, 4)[0]

def 记录(off):
    end = buf.index(b"\0", off)
    省, 市, *_ = buf[off:end].decode("utf-8").split("|")
    return f"{省}|{市}"

城市们, 城市号 = [], {}
起, 止 = 1300000, 2000000
值们 = [0xFFFF] * (止 - 起)
条数 = 0
for i in range(索引起, len(buf) - 8, 9):
    前缀, 偏移, 运营商 = struct.unpack_from("<iib", buf, i)
    if not (起 <= 前缀 < 止):
        continue
    名 = 记录(偏移)
    if 名 not in 城市号:
        城市号[名] = len(城市们)
        城市们.append(名)
    值们[前缀 - 起] = 城市号[名] * 8 + (运营商 & 7)
    条数 += 1

out = bytearray()
def varint(n):
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return
段数 = 0
i = 0
while i < len(值们):
    j = i
    while j < len(值们) and 值们[j] == 值们[i]:
        j += 1
    varint(j - i)
    out += struct.pack("<H", 值们[i])
    段数 += 1
    i = j

压 = zlib.compress(bytes(out), 9)
b64 = base64.b64encode(压).decode("ascii")
行宽 = 120
块 = [b64[k:k + 行宽] for k in range(0, len(b64), 行宽)]

目标 = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "lib", "enterprise", "phone-region-data.ts")
with open(目标, "w", encoding="utf-8") as f:
    f.write(f"// 生成的文件，别手改：python3 -I scripts/make-phone-region.py <phone.dat>。数据版本 {版本}，{条数} 个号段，{段数} 段游程。\n")
    f.write("// 数据来源 phone2region 0.0.3 的 phone.dat（MIT；上游 pangongzi/phone），说明见 scripts/make-phone-region.py\n\n")
    f.write(f"export const 数据版本 = {版本!r};\n\n")
    f.write("/** 城市序号 → 「省|市」 */\n")
    f.write("export const 城市表: readonly string[] = [\n")
    for k in range(0, len(城市们), 8):
        f.write("  " + " ".join(f'"{c}",' for c in 城市们[k:k + 8]) + "\n")
    f.write("];\n\n")
    f.write("/** 前 7 位从 1300000 起的游程表（varint 段长 + uint16 LE 值），deflate + base64 */\n")
    # 拆成数组再 join：一长串 + 连起来 eslint / tsc 的解析会爆栈
    f.write("export const 游程 = [\n")
    f.write("".join(f'  "{c}",\n' for c in 块))
    f.write("].join(\"\");\n")
print(f"版本 {版本}，号段 {条数}，城市 {len(城市们)}，游程 {段数}，原始 {len(out)} 字节，压缩 {len(压)} 字节，base64 {len(b64)} 字节")
