/**
 * 头像上的字（手机伴侣、运营台共用；2026-10-19 团队版主动排查从 lib/mobile/view.ts 挪出来）。
 */
const 汉字类 = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const 拼音字母 = /[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{N}]/u;
/**
 * 头像上的字：中日韩取第一个字；拉丁 / 西里尔取前两个词的首字母；阿拉伯这类连写的取一个字母。
 * 按码点走（emoji 是两个 UTF-16 单元，slice 会切出半个，显示成「�」），跳过引号、括号这些标点（俄文公司名常以 ООО «…» 开头）。
 * 一个字母都没有（全是 emoji）就用第一个 emoji
 */
export function 简称(name: string) {
  const s = name.trim();
  const 汉 = s.match(汉字类);
  const 首字母 = s.split(/\s+/).map((w) => w.match(/[\p{L}\p{N}]/u)?.[0]).filter((x): x is string => !!x);
  if (首字母.length && 汉 && s.indexOf(汉[0]) <= s.indexOf(首字母[0])) return 汉[0];
  if (首字母.length) {
    if (!拼音字母.test(首字母[0])) return 首字母[0];
    return 首字母.filter((x) => 拼音字母.test(x)).slice(0, 2).join("").toUpperCase();
  }
  const 图 = s.match(/\p{Extended_Pictographic}/u);
  return 图 ? 图[0] : "·";
}
