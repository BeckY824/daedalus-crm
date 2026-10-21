/**
 * 扫名片（手机伴侣，2026-10-19）的字段拆分：从实测原型 card-ocr-lab/src/parse.ts 搬过来，规则没改。
 * 实测：05-反馈与复盘/名片识别-实测-20261019/汇总.md（清楚照片字段准确率 99%，多语言自动 91%）。
 *
 * 原型说明：OCR 出来的一行行字（带框）→ 名字 / 公司 / 职位 / 电话 / WhatsApp / 微信 / 邮箱 / 官网 / 国家 / 地址。
 * 纯规则 + 字号 / 位置，不调任何服务。
 *
 * 顺序：先认「长得最有特征」的（邮箱、网址、电话、微信），从行里抠掉；剩下的再分公司 / 职位 / 地址；
 * 最后在没人要的行里按「字最大、离职位近、像人名」挑名字。
 */
import { findPhoneNumbersInText, getCountryCallingCode, type CountryCode } from "libphonenumber-js/max";

export type 框 = {
  text: string;
  score: number;
  /** 0 = 正面，1 = 反面 */
  side: number;
  /** 框的中心、宽、行高（行高按四边形两条竖边的平均长度算，拍歪了也不会被放大） */
  cx: number;
  cy: number;
  w: number;
  h: number;
};

export type 电话 = {
  e164: string; 类: "手机" | "座机" | "传真" | "WhatsApp" | "不确定"; 国家?: string; 核实: boolean; 原文: string;
  /** 号段是手机号（标签写的是 Tel 也可能是手机：泰国名片「Tel: +66 99…」） */
  手机号段?: boolean;
};

export type 字段 = {
  name: string | null;
  nameAlt: string[];
  company: string | null;
  companyAlt: string[];
  title: string | null;
  titleAlt: string[];
  phones: 电话[];
  /** 名片上明写了 WhatsApp 的号；只写了「WhatsApp」字样（二维码下面）、号码没标的，取那个手机号，并进 待核 */
  whatsapp: string | null;
  /** 没写 WhatsApp 时，界面上建议「第一个手机号也加成 WhatsApp」，不计分 */
  whatsapp建议: string | null;
  wechat: string | null;
  email: string | null;
  website: string | null;
  country: string | null;
  address: string | null;
  /** 没归到任何字段的行（界面上给用户点选「这是名字 / 公司 / 职位」） */
  剩下: string[];
  /** 规则觉得可疑、界面上标黄请人看一眼的字段（比如邮箱域名和官网差一两个字母、OCR 置信度低） */
  待核: string[];
  /** 名片上没有人名（只有公司）时，界面上建议「用公司名当名字」，不计分 */
  name建议: string | null;
  /** 从文字体系 / 地名 / 区号 / 域名猜出来的名片语言，给「换语言重认」用 */
  语言线索: string[];
};

/** paddle 返回四边形；tesseract 返回矩形。统一成 框 */
export function 四边形转框(poly: { x: number; y: number }[] | number[][], text: string, score: number, side: number): 框 {
  const p = (poly as ({ x: number; y: number } | number[])[]).map((q) => (Array.isArray(q) ? { x: q[0], y: q[1] } : q));
  const d = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
  const cx = p.reduce((s, q) => s + q.x, 0) / p.length;
  const cy = p.reduce((s, q) => s + q.y, 0) / p.length;
  if (p.length < 4) return { text, score, side, cx, cy, w: 0, h: 0 };
  return { text, score, side, cx, cy, w: (d(p[0], p[1]) + d(p[3], p[2])) / 2, h: (d(p[0], p[3]) + d(p[1], p[2])) / 2 };
}

const 汉 = /[㐀-鿿]/;
const 韩 = /[가-힣]/;
const 假名 = /[ぁ-ゟ゠-ヿ]/;
const 阿 = /[\u0621-\u064A\u0671-\u06D3\uFB50-\uFDFF\uFE70-\uFEFF]/;
const 泰 = /[\u0E01-\u0E5B]/;
const 西里尔 = /[\u0400-\u04FF]/;
const 天城 = /[\u0900-\u097F]/;
/** 日文特有的写法（简体中文里不这么写） */
const 日文词 = /(株式会社|有限会社|〒|丁目|携帯|営業|㈱)/;
/** 一行字是哪种文字（取第一个非拉丁的） */
export function 文字(s: string): "韩" | "日" | "阿拉伯" | "泰" | "西里尔" | "天城" | "汉" | "拉丁" {
  if (韩.test(s)) return "韩";
  if (假名.test(s) || 日文词.test(s)) return "日";
  if (阿.test(s)) return "阿拉伯";
  if (泰.test(s)) return "泰";
  if (西里尔.test(s)) return "西里尔";
  if (天城.test(s)) return "天城";
  if (汉.test(s)) return "汉";
  return "拉丁";
}
const 繁体字 = /[們這個國際貿業務總監經電話號碼樓區廣東](?!.*[们这个国际贸业务总监经电话号码楼区广东])/;

// 多语言标签：C.P / H.P（韩）、携帯（日）、جوال / نقال / موبايل（阿）、มือถือ（泰）、Моб.（俄）、Cep（土）、Móvil / Cel（西葡）、Port.（法）、Di động（越）、मोबाइल（印地）
const 手机词 = "手机|手機|移动|Mobile|Mob|Cell|Cel|Celular|Móvil|Movil|Cep|Port|Portable|GSM|Handy|Di\\s*động|DĐ|C\\.?\\s?P|H\\.?\\s?P|M|携帯|휴대폰|핸드폰|휴대전화|모바일|جوال|جوّال|نقال|موبايل|محمول|มือถือ|Моб|Мобильный|Сот|मोबाइल";
const 传真词 = "传真|傳真|Fax|F|팩스|ファックス|فاكس|แฟกซ์|Факс|फ़ैक्स|फैक्स";
const 座机词 = "电话|電話|座机|Tel|Tél|Téléphone|Telefone|Teléfono|Phone|Ph|Office|Direct|ĐT|Điện\\s*thoại|T|P|전화|TEL|هاتف|تليفون|تلفون|โทร|โทรศัพท์|Тел|Телефон|फोन|फ़ोन";
const 尾 = "\\s*[./:：]?\\s*[./:：]?\\s*$";
const 标签 = {
  手机: new RegExp(`(${手机词})${尾}`, "iu"),
  传真: new RegExp(`(${传真词})${尾}`, "iu"),
  WhatsApp: /(WhatsApp|WA|Whats\s*App|واتساب|واتس)\s*[./:：]?\s*$/iu,
  座机: new RegExp(`(${座机词})${尾}`, "iu"),
};

/** 国家名 / 城市 → ISO2。只放常见外贸国家；够原型用 */
const 国家词: [RegExp, string][] = [
  [/香港(?![东西南北中]?[路街道])|Hong\s*Kong|Kowloon|九龍|九龙|\bHK\b/i, "HK"],
  [/澳門|澳门|Macau|Macao/i, "MO"],
  [/台灣|台湾|Taiwan|台北/i, "TW"],
  [/United\s*Kingdom|\bUK\b|England|London|Manchester|Birmingham/i, "GB"],
  [/Germany|Deutschland|München|Munich|Berlin|Hamburg|Frankfurt/i, "DE"],
  [/Italy|Italia|Milano|Milan|Roma\b|Treviso|Torino/i, "IT"],
  [/France|Paris|Lyon/i, "FR"],
  [/Spain|España|Madrid|Barcelona/i, "ES"],
  [/\bUAE\b|U\.A\.E|Dubai|Abu\s*Dhabi|Sharjah|United\s*Arab/i, "AE"],
  [/India|Mumbai|Delhi|Bangalore|Chennai/i, "IN"],
  [/Australia|Sydney|Melbourne|\bNSW\b|\bVIC\b|\bQLD\b/i, "AU"],
  [/Brazil|Brasil|São\s*Paulo|Sao\s*Paulo|Rio\s*de/i, "BR"],
  [/\bUSA\b|U\.S\.A|United\s*States|New\s*York|\bNY\s*\d{5}|California|\bCA\s*\d{5}|Texas/i, "US"],
  [/Canada|Toronto|Vancouver/i, "CA"],
  [/Netherlands|Holland|Amsterdam|Rotterdam/i, "NL"],
  [/Turkey|Türkiye|Istanbul/i, "TR"],
  [/Saudi|Riyadh|Jeddah/i, "SA"],
  [/Singapore/i, "SG"],
  [/Malaysia|Kuala\s*Lumpur/i, "MY"],
  [/Vietnam|Viet\s*Nam|Hanoi|Ho\s*Chi\s*Minh/i, "VN"],
  [/Thailand|Bangkok/i, "TH"],
  [/Indonesia|Jakarta/i, "ID"],
  [/Philippines|Manila/i, "PH"],
  [/Japan|Tokyo|Osaka|日本/i, "JP"],
  [/Korea|Seoul|韩国|韓國/i, "KR"],
  [/Mexico|México/i, "MX"],
  [/Russia|Moscow/i, "RU"],
  [/Poland|Polska|Warsaw/i, "PL"],
  [/Nigeria|Lagos/i, "NG"],
  [/South\s*Africa|Johannesburg|Cape\s*Town/i, "ZA"],
  [/Egypt|Cairo/i, "EG"],
  [/Morocco|Maroc|Casablanca|Agadir|Tan[- ]?Tan|Tanger|المغرب/i, "MA"],
  [/Oman|Muscat|سلطنة\s*عمان|مسقط/i, "OM"],
  [/Qatar|Doha|قطر|الدوحة/i, "QA"],
  [/Kuwait|الكويت/i, "KW"],
  [/Bahrain|البحرين/i, "BH"],
  [/Jordan|الأردن/i, "JO"],
  [/السعودية|الرياض|جدة|الدمام/, "SA"],
  [/الإمارات|دبي|أبوظبي|الشارقة/, "AE"],
  [/مصر|القاهرة|الإسكندرية/, "EG"],
  [/Chile|Puerto\s*Montt|Santiago/i, "CL"],
  [/Peru|Perú|Lima\b/i, "PE"],
  [/Ecuador|Guayaquil/i, "EC"],
  [/Argentina|Buenos\s*Aires/i, "AR"],
  [/Portugal|Lisboa|Porto\b/i, "PT"],
  [/Norway|Norge|Oslo|Bergen|Ålesund/i, "NO"],
  [/Pakistan|Karachi|Lahore/i, "PK"],
  [/Bangladesh|Dhaka|Chittagong/i, "BD"],
  [/Sri\s*Lanka|Colombo/i, "LK"],
  [/대한민국|한국|서울|부산|인천|대구|광주|대전|울산/, "KR"],
  [/東京|大阪|北海道|札幌|名古屋|福岡|横浜|築地|〒/, "JP"],
  [/ประเทศไทย|กรุงเทพ|ภูเก็ต|เชียงใหม่|ชลบุรี|สมุทรสาคร/, "TH"],
  [/Россия|Москва|Санкт-Петербург|Владивосток|Мурманск|Калининград/, "RU"],
  [/Türkiye|İzmir|Izmir|Ankara/i, "TR"],
  [/Việt\s*Nam|Hồ\s*Chí\s*Minh|Hà\s*Nội|Đà\s*Nẵng/i, "VN"],
  [/भारत|मुंबई|दिल्ली/, "IN"],
  [/China|P\.R\.C|中国|中國|北京|上海|深圳|广州|廣州|杭州|宁波|寧波|义乌|義烏|佛山|东莞|東莞|厦门|廈門|南京|苏州|蘇州|青岛|天津|重庆|成都|武汉/i, "CN"],
];

const 公司强 = /(有限公司|有限責任公司|有限责任公司|股份公司|集团|集團|公司|工厂|工廠|商行|(?<![\p{L}\d])(Ltd|Limited|LLC|L\.L\.C|Inc|Incorporated|Corp|Corporation|GmbH|AG|S\.?p\.?A|S\.?r\.?[lI1]|S\.?L|S\.?A|SARL|SAS|B\.?V|N\.?V|Pty|Pvt|Ltda|PLC|LLP|Co\.?,?\s*Ltd|(?:O|C|P)?JSC|K\.?K|Oy|AB|A\/S)(?![\p{L}\d])\.?)/iu; // 不用 \b：「Elüslé」里的 sl 会被当成 S.L
const 公司弱 = /\b(Trading|Group|Industries|Industrial|Enterprises?|Exports?|Imports?|Importadora|Supply|Supplies|International|Manufacturing|Technology|Technologies|Holdings|Foods?|Seafoods?|Fisheries|Fishery|Aquatic|F&B|Est)\b/i;
/** 其它语言的公司后缀（不能用 \b：韩 / 日 / 阿 / 泰 / 俄文字母不算「单词字符」） */
const 公司强外 = /(주식회사|\(주\)|㈜|株式会社|有限会社|㈱|شركة|مؤسسة|ش\.?\s?م\.?\s?م|ذ\.?\s?م\.?\s?م|المحدودة|บริษัท|จำกัด|(^|[\s«"])(ООО|ОАО|ЗАО|ПАО|АО|ИП)(?=[\s«"]|$)|(^|\s)(000|OOO|OAO|AO)(?=\s*[«"„“])|Công\s*ty|TNHH|A\.\s?[ŞS][.,]?(?=\s|$)|Ltd\.?\s?Şti|प्राइवेट|लिमिटेड)/u;
const 公司弱外 = /(수산|물산|식품|무역|상사|F&B|水産|物産|食品|商事|貿易|للأغذية|للتصدير|لتجارة|Морепродукты|Рыба|рыба)/u;
const 是公司强 = (t: string) => 公司强.test(t) || 公司强外.test(t);
const 是公司弱 = (t: string) => 公司弱.test(t) || 公司弱外.test(t);

const 职位词 = /(总经理|總經理|副总|副總|经理|經理|总监|總監|主管|主任|总裁|總裁|董事长|董事長|董事|专员|專員|代表|工程师|工程師|业务|業務|销售|銷售|采购|採購|助理|顾问|顧問|合伙人|合夥人|创始人|創始人|老板|老闆|厂长|廠長|部长|部長|\b(Manager|Director|CEO|CFO|COO|CTO|Founder|Co-?founder|Owner|President|Vice\s*President|VP|Buyer|Head\s+of|Lead|Coordinator|Engineer|Officer|Executive|Partner|Representative|Rep|Specialist|Assistant|Supervisor|Consultant|Chairman|Purchasing|Procurement|Sales|Sourcing|Merchandiser|Agent|Administrator|Designer|Gerente|Directora?|Jefe|Directeur|Directrice|Responsable|Gérant|Müdür|Müdürü)\b|대리|과장|차장|부장|팀장|실장|이사|상무|전무|대표|사장|사원|주임|매니저|課長|係長|社長|取締役|専務|常務|担当|المدير|مدير|رئيس|مسؤول|مندوب|ผู้จัดการ|กรรมการ|ผู้อำนวยการ|ฝ่ายขาย|Директор|директор|Менеджер|менеджер|Руководитель|Начальник|Специалист|Giám\s*đốc|Trưởng\s*phòng|Nhân\s*viên|प्रबंधक|निदेशक|अधिकारी)/iu;

const 地址词汉 = /(省|市|区|區|县|縣|镇|鎮|乡|鄉|路|街|道|号|號|楼|樓|栋|棟|室|大厦|大廈|广场|廣場|园区|園區|工业|工業)/;
/** 韩 / 日 / 阿 / 泰 / 俄 / 越 / 土的地址词 */
const 地址词外 = /(특별시|광역시|[가-힣]+[시구군]\s|[가-힣]+(로|길)\s*\d|\d+\s*층|빌딩|번지|丁目|〒|都|道|府|県|شارع|ص\.?\s?ب|الرمز\s*البريدي|طريق|مبنى|ถนน|แขวง|เขต|ตำบล|อำเภอ|จังหวัด|ซอย|กรุงเทพ|ул\.|улица|пр-т|проспект|(^|\s)г\.|(^|\s)д\.\s?\d|офис|Quận|Phường|Đường|Mah\.|Sok\.|Cad\.|No:\s?\d)/u;
const 地址词英 = /\b(Street|St|Road|Rd|Avenue|Ave|Av|Boulevard|Blvd|Lane|Ln|Drive|Dr|Way|Suite|Unit|Floor|Fl|\d+\/?F|Office\s+\d+|Park|Via|Viale|Calle|Rue|Avenida|Industriestra(ß|ss|B)e|Stra(ß|ss|B)e|Str|No\.|Tower|Building|Bldg|Plaza|Zone|District|Area|Estate|Road|P\.?O\.?\s*Box|Suburb|Industrial|Port(?!\.)|Puerto|Porto)\b/i;

const 邮箱re = /[A-Za-z0-9._%+-]+\s?@\s?[A-Za-z0-9-]+(?:\s?\.\s?[A-Za-z0-9-]+)*\s?\.\s?[A-Za-z]{2,}/g;
const 顶级 = "com|net|org|info|biz|io|co|cn|uk|de|it|fr|es|ae|in|au|br|hk|jp|kr|ru|nl|ch|se|eu|us|ca|mx|tr|sa|sg|my|vn|th|id|ph|pl|za|eg|ng|tw|mo|be|at|pt|dk|no|fi|gr|nz|ie|cz|hu|ro|il|pk|bd|lk|ke|ma|tn|ar|cl|pe|ua|shop|store|online|site|tech|top|xyz|cc|tv|me";
const 网址re = new RegExp(`(?:https?:\\/\\/)?(?:www\\s?\\.\\s?)?[A-Za-z0-9][A-Za-z0-9-]*(?:\\.[A-Za-z0-9-]+)*\\.(?:${顶级})(?:\\.[a-z]{2})?(?![A-Za-z0-9-])(?:\\/[^\\s]*)?`, "gi");

/**
 * 阿拉伯文：PaddleOCR 认出来的字是「从左往右看到的顺序」（视觉顺序），要倒回阅读顺序。
 * 做法和 PaddleOCR Python 版一样：整行倒过来，但拉丁字母 / 数字 / 空格这些从左往右写的连续段保持原样
 * （Python 版没把阿拉伯-印度数字算进去，数字会被倒乱；这里算进去）。
 */
export function 视觉转阅读(s: string) {
  if (!阿.test(s)) return s;
  // 1. 拉丁字母开头的一串（英文词、邮箱、网址、带标签的号码）在名片上本来就是从左往右，原样留着
  const 拉丁: string[] = [];
  let t = s.replace(/[A-Za-z][A-Za-z0-9@._%\/&'+:,()-]*(?:\s+[A-Za-z0-9+(][A-Za-z0-9@._%\/&'+:,()-]*)*/g, (m) => String.fromCharCode(0xe000 + 拉丁.push(m) - 1));
  // 2. 整行倒过来（阿拉伯字母是从右往左认出来的），3. 再把每组数字倒回去
  t = [...t].reverse().join("").replace(/[0-9٠-٩۰-۹](?:[0-9٠-٩۰-۹.,\/-]*[0-9٠-٩۰-۹])?/g, (m) => [...m].reverse().join(""));
  t = t.replace(/[-]/g, (c) => 拉丁[c.charCodeAt(0) - 0xe000]);
  // 4. 号码在设计时被当成从左往右排的：倒完变成「4567 9123 968+」，把组的次序翻回来
  return t.replace(/((?:[0-9٠-٩۰-۹][0-9٠-٩۰-۹-]*\s*)+)\+/g, (_m, g: string) => "+" + g.trim().split(/\s+/).reverse().join(" "));
}

/** OCR 出来的字先统一：全角转半角（「：」保留成半角冒号也无妨）、各种破折号变成 -、阿拉伯-印度数字变普通数字 */
export const 统一 = (s: string) =>
  s.normalize("NFKC").replace(/[\u2010-\u2015\u2212]/g, "-")
    // NFKC 会把泰文「ำ」拆成「ํ」+「า」（จำกัด → จํากัด，看着一样、搜不到）：拼回去
    .replace(/\u0E4D\u0E32/g, "\u0E33")
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06F0))
    .replace(/،/g, ",").replace(/؛/g, ";")
    // 俄文词里混进长得一样的拉丁字母（AО«Восток）：换成西里尔字母
    .replace(/[\p{L}]+/gu, (w) => (/[\u0400-\u04FF]/.test(w) && /[A-Za-z]/.test(w) ? w.replace(/[AaBEeKkMHOoPpCcTXxy]/g, (c) => "АаВЕеКкМНОоРрСсТХху"["AaBEeKkMHOoPpCcTXxy".indexOf(c)]) : w))
    // Tesseract 爱在汉字之间加空格（「销售 经 理」）：汉字挨汉字的空格去掉
    .replace(/(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, "");
/** OCR 把两个英文词粘在一起（PurchasingCoordinator / LumièreSARL）：判断类别时按大小写拆开再看 */
const 拆词 = (s: string) => s.replace(/([a-zà-ÿ])([A-Z][a-zà-ÿ]{2,}|[A-Z]{3,})/g, "$1 $2"); // GmbH、McK 这种不拆

/** 域名结尾 OCR 常见的认错：.corm / .comn → .com */
const 修域名 = (s: string) => s.replace(/\.(corm|comn|c0m|coom)$/, ".com");

/** 公司后缀里 OCR 常见的认错：S.r.I. → S.r.l.（小写 L 认成大写 i） */
export const 修后缀 = (s: string) => s.replace(/S\.r\.[I1]\.?$/, "S.r.l.").replace(/\bLld\b/, "Ltd").replace(/^(000|OOO)(?=\s*[«"„“])/, "ООО").replace(/^AO(?=\s*[«"„“])/, "АО");
const 清 = (s: string) => s.replace(/\s+/g, " ").trim();
const 去头标签 = (s: string) =>
  清(s.replace(/^\s*(地址|地 址|Add(ress)?|Addr|微信|WeChat|公司|Company|职位|Title|姓名|Name)\s*[./:：]?\s*/i, ""));
const 去分隔 = (s: string) => 清(s.replace(/^[\s|｜·•,，:：/、-]+|[\s|｜·•,，:：/、-]+$/g, ""));

/** 只有汉字、去掉空格后 2–4 个字 */
function 像中文名(s: string) {
  const t = s.replace(/\s+/g, "");
  return /^[㐀-鿿]{2,4}$/.test(t);
}
/** 2–4 个单词，每个大写开头（允许 O'Connor、带重音的字母、连字符；俄文、越南文字母也算） */
function 像英文名(s: string) {
  const ws = 清(s).split(" ");
  if (ws.length < 2 || ws.length > 4 || s.length > 32) return false;
  return ws.every((w) => /^\p{Lu}[\p{Ll}'’\p{Lu}.-]*$/u.test(w)) && !/\d/.test(s);
}
/** 韩文名 2–4 个字（常写成「방 소 재」）；阿拉伯 / 泰 / 印地文名 1–4 个词、不长、没数字 */
function 像外文名(s: string) {
  const t = 清(s);
  if (/\d|@/.test(t) || t.length > 30) return false;
  if (韩.test(t)) return /^[가-힣]{2,4}$/.test(t.replace(/\s+/g, ""));
  const ws = t.split(" ");
  if (阿.test(t)) return ws.length >= 2 && ws.length <= 4 && ws.every((w) => 阿.test(w));
  if (泰.test(t)) return ws.length >= 1 && ws.length <= 3 && ws.every((w) => 泰.test(w)) && t.length <= 24;
  if (天城.test(t)) return ws.length >= 2 && ws.length <= 4 && ws.every((w) => 天城.test(w));
  // 越南名：常见姓开头、2–4 个词（中间的「Văn / Thị」是小写）；声调常认错，去掉声调再比
  if (ws.length >= 2 && ws.length <= 4 && 越南姓.test(去声调(ws[0])) && ws.every((w) => /^\p{L}+$/u.test(w))) return true;
  return false;
}
const 去声调 = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").replace(/[đĐ]/g, (c) => (c === "đ" ? "d" : "D"));
const 越南姓 = /^(Nguyen|Tran|Le|Pham|Hoang|Huynh|Phan|Vu|Vo|Dang|Bui|Do|Ho|Ngo|Duong|Ly|Truong|Dinh|Lam|Mai|Trinh)$/;
/** 越南文职位：声调常认错（Giám dôć），去掉声调再找 */
const 越南职位 = /\b(Pho\s+)?(Giam\s*doc|Truong\s*phong|Nhan\s*vien|Quan\s*ly|Ke\s*toan)\b/i;
/** 名片语言的线索：文字体系、区号、域名、地名 → 识别模型的语言名 */
const 区号语言: [RegExp, string][] = [
  [/\+\s?82\b/, "韩"], [/\+\s?81\b/, "日"], [/\+\s?66\b/, "泰"],
  [/\+\s?(966|971|968|974|965|973|962|20|964|963|961|967|218|216|213)\b/, "阿拉伯"],
  [/\+\s?(7|375|380|998|996|992)\b/, "西里尔"], [/\+\s?(91|977)\b/, "天城"],
];
const 域名语言: [RegExp, string][] = [
  [/\.kr\b/i, "韩"], [/\.jp\b/i, "日"], [/\.th\b/i, "泰"],
  [/\.(sa|ae|om|qa|kw|bh|jo|eg|iq|sy|lb|ye|ly|tn|dz)\b/i, "阿拉伯"],
  [/\.(ru|by|ua|kz|uz|kg|tj)\b/i, "西里尔"], [/\.in\b/i, "天城"],
];
const 国家语言: Record<string, string> = { KR: "韩", JP: "日", TH: "泰", SA: "阿拉伯", AE: "阿拉伯", OM: "阿拉伯", QA: "阿拉伯", KW: "阿拉伯", BH: "阿拉伯", JO: "阿拉伯", EG: "阿拉伯", RU: "西里尔", IN: "天城" };
/** 西里尔字母被中英模型认成长得像的拉丁字母（Иван → VBaH，Петров → ∏etpoB）：小写中间夹大写 H/B/K/M/T、∏、bI */
export function 像假拉丁(s: string) {
  return (s.match(/[a-z][HBKMTP][a-z]|∏|bI|[a-z]6[a-z.]|[A-Z]{1,2}[a-z]?[HBKM][a-z]/g) ?? []).length;
}

/**
 * 「名片上还有」里去掉噪音（10-20 用户：标语、logo 字进了备注）：
 *   - 不到 2 个字母的（二维码、图标被认成的一两个字）、认得很没把握的（< 0.5）
 *   - logo 字：去掉空格标点后是公司名 / 邮箱 / 官网里的一截（「Haedam」← haedam.co.kr，「NORD)L」← nordlicht.de）
 *   - 标语：紧挨在 logo 字上下、同一栏的几行（「건강한 식탁을 위한 / Your Daily Partner」）；
 *     紧挨在公司名上下、字明显小、不带数字的一行（「品质成就未来」「Свежесть с Севера」）；「Since 1952」这类创立年份
 */
type 行 = 框 & { rest: string };
/** u 是不是紧挨在 x 上下、同一栏、字明显小的一行（公司名旁边的标语 / 业务说明） */
function 挨着小字(u: 框 & { rest: string }, x: 框) {
  return u !== x && u.side === x.side && u.h < 0.8 * x.h && Math.abs(u.cy - x.cy) < 2.2 * x.h && !/[@\d]/.test(u.rest) &&
    Math.min(u.cx + u.w / 2, x.cx + x.w / 2) - Math.max(u.cx - u.w / 2, x.cx - x.w / 2) > 0.3 * Math.min(u.w, x.w);
}
const 创立年 = /\b(since|est\.?|established|founded)\s*(in\s*)?(19|20)\d{2}\b|(创立|成立|始创|創業|創立)于?\s*(19|20)\d{2}/iu;
function 去噪音<T extends 行>(行们: T[], 有的: string[], 公司行们: 框[] = []): T[] {
  const 紧 = (t: string) => t.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const 库 = 有的.flatMap((x) => [紧(x), ...x.split(/[@.]/).map(紧)]).filter((x) => x.length >= 3);
  const 字母数 = (t: string) => t.match(/\p{L}/gu)?.length ?? 0;
  const 是logo = (l: T) => { const k = 紧(l.rest); return k.length >= 3 && 库.some((x) => x.includes(k)); };
  const logo们 = 行们.filter(是logo);
  const 挨着logo = (l: T) => logo们.some((g) => g !== l && g.side === l.side && Math.abs(l.cy - g.cy) < 4 * Math.max(g.h, l.h) &&
    Math.min(l.cx + l.w / 2, g.cx + g.w / 2) - Math.max(l.cx - l.w / 2, g.cx - g.w / 2) > 0.3 * Math.min(l.w, g.w));
  // 号码标签剩下的（「Мо6.」「Di động」「DT」：认错一个字，前面没抠掉）、单独一行的国家名（国家那格已经有了）、logo 缩写（HB / SF）
  const 标签残 = new RegExp(`^(${手机词}|${传真词}|${座机词}|Мо6|Di\\s*dong|DT|携带)\\s*[./:：]?$`, "iu");
  const 杂 = (l: T) => 标签残.test(去声调(清(l.rest))) || /^[A-Z]{2,3}$/.test(l.rest.trim()) || 创立年.test(l.rest) ||
    公司行们.some((x) => 挨着小字(l, x)) ||
    国家词.some(([re]) => re.test(l.rest) && 清(l.rest.replace(re, "")).length === 0);
  return 行们.filter((l) => 字母数(l.rest) >= 2 && l.score >= 0.5 && !是logo(l) && !挨着logo(l) && !杂(l));
}

/**
 * 读的顺序：正面在前；同一面从上到下、同一行从左到右。拆字段和 AI 整理（ai.ts 按行号回答）都按这个顺序，行号两边对得上。
 * 名片横躺着拍（照片转了 90°）：大部分框是竖的，就把坐标转回横的（按顺时针躺着算：越靠右越是上面的行）
 */
export function 排好的行(框们: 框[]): 框[] {
  const 竖 = 框们.filter((b) => b.text.trim().length >= 4);
  const 躺着 = 竖.length >= 3 && 竖.filter((b) => b.h > 1.5 * b.w).length >= 0.6 * 竖.length;
  return [...框们]
    .map((b) => (躺着 ? { ...b, cx: b.cy, cy: -b.cx, w: b.h, h: b.w } : b))
    .map((b) => ({ ...b, text: 统一(视觉转阅读(b.text)) }))
    .filter((b) => b.text.trim())
    .sort((a, b) => a.side - b.side || (Math.abs(a.cy - b.cy) < Math.min(a.h, b.h) * 0.6 ? a.cx - b.cx : a.cy - b.cy));
}

export function 拆字段(框们: 框[]): 字段 {
  const 行们 = 排好的行(框们).map((b) => ({ ...b, rest: b.text, 用: "" as string }));

  const 全文 = 行们.map((l) => l.text).join("\n");
  // 韩文 / 日文被中英模型认成的「汉字」置信度都低：只看认得有把握的行
  const 有汉字 = 行们.some((l) => l.score >= 0.85 && 汉.test(l.text));

  // ---- 国家先从地址里的国家名 / 城市猜，给不带 + 号的电话当默认区号
  let 地名国家: string | null = null;
  for (const l of 行们) {
    if (邮箱re.test(l.text)) { 邮箱re.lastIndex = 0; continue; }
    for (const [re, c] of 国家词) if (re.test(l.text) && !网址re.test(l.text)) { 地名国家 = 地名国家 ?? c; 网址re.lastIndex = 0; break; }
    网址re.lastIndex = 0;
  }
  // 没写国家名时：邮箱 / 网址的国家域名（.kr / .om …），再不行按文字体系（韩文 → 韩国）
  const 域名国 = (() => {
    const m = 全文.match(/[@.][A-Za-z0-9-]+\.([a-z]{2})\b(?![.@\w])/i);
    const t = m?.[1].toLowerCase();
    if (!t || ["co", "io", "me", "tv", "cc", "ai"].includes(t)) return null;
    return t === "uk" ? "GB" : t.toUpperCase();
  })();
  const 文字计 = new Map<string, number>();
  for (const l of 行们) { const k = 文字(l.text); if (k !== "拉丁") 文字计.set(k, (文字计.get(k) ?? 0) + 1); }
  const 主文字 = [...文字计.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const 文字国 = ({ 韩: "KR", 日: "JP", 泰: "TH", 西里尔: "RU", 天城: "IN" } as Record<string, string>)[主文字 ?? ""] ?? null;
  const 默认国 = (地名国家 ?? 域名国 ?? 文字国 ?? (有汉字 ? "CN" : undefined)) as CountryCode | undefined;
  const 区号 = 默认国 ? getCountryCallingCode(默认国) : null;

  /** 每个字段来自哪几行：取最低的 OCR 置信度，低于 0.9 标黄 */
  const 来源分: Record<string, number> = {};
  const 记分 = (k: string, v: number) => (来源分[k] = Math.min(来源分[k] ?? 1, v));

  // ---- 邮箱
  const emails: string[] = [];
  for (const l of 行们) {
    l.rest = l.rest.replace(邮箱re, (m) => {
      emails.push(修域名(m.replace(/\s+/g, "").toLowerCase()));
      if (emails.length === 1) 记分("email", l.score);
      return " ";
    });
  }

  // ---- 网址（不和邮箱重叠：邮箱已经抠掉了）
  const sites: string[] = [];
  /** 抠出过网址的行：剩下的几个词多半是这个网址的说明（「Seafood trading www.…」「Property Agent www.…」），不是公司 / 人名 */
  const 有网址 = new Set<(typeof 行们)[number]>();
  for (const l of 行们) {
    l.rest = l.rest.replace(网址re, (m, off: number, all: string) => {
      const 前 = all.slice(Math.max(0, off - 1), off);
      // 像「S.p.A.」「Co.」不会命中顶级域名表；「Ltd.」后接空格也不会。挡一下「No.12」之类
      if (/[@\d]/.test(前)) return m;
      const t = m.replace(/\s+/g, "").replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/$/, "").toLowerCase();
      if (!/\./.test(t) || t.length < 5) return m;
      sites.push(修域名(t));
      有网址.add(l);
      if (sites.length === 1) 记分("website", l.score);
      return " ";
    });
  }

  // ---- 电话：一行一行找，号码前面 12 个字里的标签决定类型
  const phones: 电话[] = [];
  for (const l of 行们) {
    // 税号 / 注册号这类长数字不是电话（泰国名片的 VAT registration no. 0105562165740）
    if (/\b(VAT|TAX|TIN|GST|NPWP|CR|NIF|CIF|RUC|RFC|ICE|Reg(istration)?|Company\s*No|ИНН|ОГРН|КПП)\b|统一社会信用代码|税号|사업자/iu.test(l.rest) && /\d{8,}/.test(l.rest.replace(/[\s-]/g, ""))) { l.用 = "联系方式"; continue; }
    // 号码之间没有空格、连成一长串（阿拉伯文名片常见：+968 92752313، +968 96195133 认成一串）：按本国区号切开
    let s = l.rest;
    if (区号) s = s.replace(/\d{16,}/g, (run) => {
      const 段 = run.split(new RegExp(`(?=${区号}\\d{7,10})`)).filter(Boolean);
      return 段.length > 1 && 段.every((x) => x.startsWith(区号) && x.length >= 区号.length + 7 && x.length <= 区号.length + 11) ? 段.map((x) => "+" + x).join(" , ") : run;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- leniency 不在公开类型里，返回值按 max 版用
    const 找到 = findPhoneNumbersInText(s, { defaultCountry: 默认国, leniency: "POSSIBLE" } as any) as any[];
    if (!找到.length) continue;
    let 剩 = s;
    for (const f of 找到) {
      // 宽松模式会把邮编、门牌号也当号码：没核实过的，必须带 + 号且至少 8 位数字才留
      const 原 = s.slice(f.startsAt, f.endsAt);
      if (!f.number.isValid() && (!/^\s*\+/.test(原) || 原.replace(/\D/g, "").length < 8)) continue;
      const 前文 = s.slice(Math.max(0, f.startsAt - 14), f.startsAt);
      const 类: 电话["类"] = 标签.WhatsApp.test(前文) || /WhatsApp/i.test(前文)
        ? "WhatsApp"
        : 标签.传真.test(前文) ? "传真"
        : 标签.手机.test(前文) ? "手机"
        : 标签.座机.test(前文) ? "座机"
        : f.number.getType() === "MOBILE" ? "手机" : f.number.getType() === "FIXED_LINE" ? "座机" : "不确定";
      const e164 = f.number.number as string;
      // 「手机/WhatsApp：」这种：标签里两样都有，算手机，同时记 WhatsApp
      const 也是WA = /WhatsApp|WA\b/i.test(前文);
      const 号段 = f.number.getType();
      if (!phones.some((p) => p.e164 === e164)) { phones.push({ e164, 类: 也是WA ? "WhatsApp" : 类, 国家: f.number.country, 核实: f.number.isValid(), 原文: s.slice(f.startsAt, f.endsAt), 手机号段: 号段 === "MOBILE" || 号段 === "FIXED_LINE_OR_MOBILE" }); 记分("phones", l.score); }
      剩 = 剩.replace(s.slice(f.startsAt, f.endsAt), " ");
    }
    // 号码前面的标签也一起去掉
    l.rest = 剩.replace(new RegExp(`(?<![\\p{L}])(${手机词}|${传真词}|${座机词}|WhatsApp|واتساب)\\s*[./:：]?\\s*[./:：]?(?=\\s|$|[|/,])`, "giu"), " ");
  }

  // ---- 微信
  let wechat: string | null = null;
  for (const l of 行们) {
    const m = l.rest.match(/(微信|微信号|WeChat|We\s*Chat|WX|Weixin)\s*(ID)?\s*[./:：]?\s*([A-Za-z][-_A-Za-z0-9]{4,24}|\d{6,15})/i);
    if (m && !wechat) {
      wechat = m[3];
      l.rest = l.rest.replace(m[0], " ");
    }
  }
  // 电话已被抠掉、剩下「微信：」空标签的情况：微信号就是那个电话
  for (const l of 行们) if (!wechat && /(微信|WeChat)\s*[:：]?\s*$/i.test(清(l.rest)) && phones.length) wechat = phones[0].e164.replace(/^\+86/, "");

  // 清掉残留的标签 / 分隔符
  for (const l of 行们) {
    // 中文标签在哪都去；英文标签必须带冒号（不然「Weber」的 Web、「straße」后面的 e 都会被吃掉）
    l.rest = 去分隔(l.rest.replace(/(邮箱|郵箱|邮件|电邮|网址|網址|微信|이메일|메일|홈페이지|البريد\s*الإلكتروني|بريد|อีเมล|อีเมล์|เว็บไซต์)\s*[./:：]?|(?<![\p{L}])(E-?mail|Email|Web(site)?|WeChat|E|W|Эл\.?\s?почта)\s*[:：]/giu, " "));
    if (!l.rest || /^[\s\p{P}\p{S}\d_]+$/u.test(l.rest)) l.用 = "联系方式";
  }
  // 只写了「WhatsApp」、旁边没号码（二维码下面那个字，10-20 泰国真名片）：记下「名片上标了 WhatsApp」，这行不再进备注
  let 标了WA = false;
  for (const l of 行们) {
    if (l.用) continue;
    if (/^(whats\s*app|wa|واتساب|واتس\s*اب)$/iu.test(清(l.rest.replace(/[\p{P}\p{S}]/gu, " ")))) { 标了WA = true; l.用 = "联系方式"; continue; }
    // 网址的说明：抠掉网址后只剩几个词、不带法定后缀
    if (有网址.has(l) && l.rest.split(/\s+/).length <= 4 && !/\d/.test(l.rest) && !是公司强(l.rest)) l.用 = "联系方式";
  }

  const 候选 = () => 行们.filter((l) => !l.用 && l.rest);

  // ---- 公司
  const 公司们 = 候选()
    .map((l) => { const t = 拆词(l.rest); return { l, 分: (是公司强(t) ? 2 : 0) + (是公司弱(t) ? 1 : 0) - (职位词.test(t) && !是公司强(t) ? 1.5 : 0) }; })
    // 置信度很低的行（认不出的外文）不当公司，免得乱码被当成公司、又被建议成名字
    .filter((x) => x.分 >= 1 && x.l.score >= 0.7 && !/@/.test(x.l.rest) && (x.l.rest.match(/\d/g)?.length ?? 0) < 4)
    .filter((x) => !((地址词英.test(x.l.rest) || 地址词外.test(x.l.rest)) && !是公司强(拆词(x.l.rest))))
    // 带法定后缀（有限公司 / Ltd / GmbH…）的优先；同样带后缀的，正面的优先（双面名片正面一般是母语）
    .sort((a, b) => Number(b.分 >= 2) - Number(a.分 >= 2) || a.l.side - b.l.side || b.分 - a.分 || b.l.h - a.l.h);
  // 公司名下面一行小字的业务说明（「Seafood Import & Distribution」）：没有法定后缀、字明显小、紧挨着选中的公司，不算另一个公司
  const 主公司 = 公司们[0];
  for (const x of 公司们.slice(1))
    if (主公司.分 >= 2 && x.分 < 2 && 挨着小字(x.l, 主公司.l)) { x.l.用 = "说明"; 公司们.splice(公司们.indexOf(x), 1); }
  for (const x of 公司们) x.l.用 = "公司";
  // 公司名分两行排（logo 旁边「GULF HOUSE」/「GROUP」）：选中的那行只有 1–2 个词时，把紧挨着、字一样大、对齐的上一行 / 下一行接上
  if (公司们[0]) {
    const x = 公司们[0].l;
    const 词数 = (t: string) => t.trim().split(/\s+/).length;
    const 挨着 = (u: (typeof 行们)[number]) =>
      u !== x && !u.用 && u.side === x.side && (u.rest.match(/\p{L}/gu)?.length ?? 0) >= 3 && !/[@\d]/.test(u.rest) && !职位词.test(u.rest) &&
      u.h / x.h > 0.7 && u.h / x.h < 1.4 && Math.abs(u.cy - x.cy) < 1.8 * Math.max(u.h, x.h) &&
      Math.min(u.cx + u.w / 2, x.cx + x.w / 2) - Math.max(u.cx - u.w / 2, x.cx - x.w / 2) > 0.5 * Math.min(u.w, x.w);
    // 选中的那行本身已经是完整公司名（「서울신선식품(주)」）就不往上接；只剩后缀（GROUP / LLC）或没有法定后缀的才接
    const 只剩后缀 = !x.rest.replace(new RegExp(公司强.source, "giu"), "").replace(new RegExp(公司强外.source, "gu"), "").replace(new RegExp(公司弱.source, "gi"), "").match(/\p{L}/u);
    const 上 = 行们.find((u) => u.cy < x.cy && 挨着(u) && 词数(x.rest) <= 2 && (只剩后缀 || !是公司强(x.rest)) && 词数(u.rest) <= 4);
    const 下 = 上 ? null : 行们.find((u) => u.cy > x.cy && 挨着(u) && 词数(u.rest) <= 2 && 是公司弱(u.rest) || (u.cy > x.cy && 挨着(u) && 词数(u.rest) <= 2 && 是公司强(u.rest)));
    if (上) { x.rest = `${上.rest.trim()} ${x.rest.trim()}`; 上.用 = "公司"; 上.rest = ""; }
    else if (下) { x.rest = `${x.rest.trim()} ${下.rest.trim()}`; 下.用 = "公司"; 下.rest = ""; }
  }

  // ---- 地址（先于职位：「Unit 4, Riverside Park」不能被当成职位）
  const 是地址 = (l: (typeof 行们)[number]) => {
    const t = 拆词(l.rest);
    if (/^(地址|Add(ress)?)\s*[:：]/i.test(l.text)) return true;
    if (地址词外.test(t) && !职位词.test(t) && !是公司强(t) && (/\d/.test(t) || t.length >= 8)) return true;
    if (汉.test(t)) return 地址词汉.test(t) && (/\d/.test(t) || t.replace(/\s/g, "").length >= 8) && !职位词.test(t);
    if (地址词英.test(t) && (/\d/.test(t) || t.split(/[ ,]+/).length >= 3)) return true;
    // 门牌号开头、后面跟单词（「350 Fifth Avenue, Suite 4100」；OCR 把 Avenue 认成 Avonue 也认得出）
    if (/^\d{1,5}[A-Za-z]?\s+[A-Za-zÀ-ÿ]{3,}/.test(t) && !/@/.test(t)) return true;
    // 单独一行国家名 / 城市+邮编；或者带数字（门牌、邮编）又带国家 / 城市名
    if (国家词.some(([re]) => re.test(t)) && (t.length <= 40 || /\d/.test(t)) && !职位词.test(t) && !像英文名(t) && !是公司强(t)) return true;
    return false;
  };
  const 地址行 = 候选().filter(是地址);
  for (const l of 地址行) l.用 = "地址";

  // ---- 职位
  const 职位们 = 候选().filter((l) => (职位词.test(拆词(l.rest)) || 越南职位.test(去声调(l.rest))) && l.rest.length <= 50 && !/@|www\./i.test(l.rest));
  for (const l of 职位们) l.用 = "职位";

  // ---- 名字：剩下的行里像人名的；字越大越像、紧挨着职位更像、是公司名里的一截（logo 字）扣分
  const 公司全 = 公司们.map((x) => x.l.rest.replace(/\s/g, "")).join("|");
  const 每面最大 = new Map<number, number>();
  for (const l of 行们) 每面最大.set(l.side, Math.max(每面最大.get(l.side) ?? 0, l.h));
  const 名字们 = 候选()
    .filter((l) => (像中文名(l.rest) || 像英文名(l.rest) || 像外文名(l.rest)) && !职位词.test(l.rest) && !是公司弱(l.rest))
    .map((l) => {
      let 分 = (l.h / (每面最大.get(l.side) || 1)) * 2;
      const 近职位 = 职位们.some((t) => t.side === l.side && Math.abs(t.cy - l.cy) < Math.max(t.h, l.h) * 3.2);
      if (近职位) 分 += 1;
      const 紧 = l.rest.replace(/\s/g, "");
      if (公司全.includes(紧)) 分 -= 2.5;
      if (/^[A-Z]{2,}$/.test(紧)) 分 -= 2;
      return { l, 分 };
    })
    .sort((a, b) => b.分 - a.分);
  const 名字 = 名字们[0]?.l;
  // 双语：另一种文字里最好的那个当备选（陈晓东 / Xiaodong Chen）
  const 名字备 = 名字们.filter((x) => x.l !== 名字 && x.分 > 0.9 && 文字(x.l.rest) !== 文字(名字?.rest ?? "")).slice(0, 1).map((x) => x.l);
  if (名字) 名字.用 = "名字";
  for (const l of 名字备) l.用 = "名字";

  // ---- 地址拼起来：同一面、上下挨着的地址行连成一条；取正面第一段
  let address: string | null = null;
  if (地址行.length) {
    const 段: (typeof 地址行)[] = [];
    for (const l of 地址行) {
      const 上 = 段.at(-1)?.at(-1);
      if (上 && 上.side === l.side && Math.abs(l.cy - 上.cy) < Math.max(l.h, 上.h) * 2.2) 段.at(-1)!.push(l);
      else 段.push([l]);
    }
    address = 段[0].map((l) => 去头标签(l.rest)).join(汉.test(段[0][0].rest) ? "" : " ");
    for (const l of 段[0]) 记分("address", l.score);
  }

  // ---- 国家：地址里的国家名 > 手机号的国家 > 其它号码的国家 > 有汉字就当中国
  const 手机国 = phones.find((p) => p.类 === "手机" || p.类 === "WhatsApp")?.国家;
  const 号码国 = phones.find((p) => p.国家)?.国家;
  const 地址国 = address ? 国家词.find(([re]) => re.test(address!))?.[1] : null;
  const country = 地址国 ?? 地名国家 ?? 手机国 ?? 号码国 ?? 域名国 ?? 文字国 ?? (有汉字 ? (繁体字.test(全文) ? "HK" : "CN") : null);

  // 邮箱域名和官网差一两个字母：多半有一个认错了，标黄请人看
  const 待核: string[] = [];
  const 邮域 = emails[0]?.split("@")[1];
  if (邮域 && sites[0] && 邮域 !== sites[0]) {
    const a = 邮域, b = sites[0];
    const 近 = Math.abs(a.length - b.length) <= 2 && [...a].filter((ch, i) => ch !== b[i]).length <= 2;
    if (近 || a.endsWith(b) || b.endsWith(a)) 待核.push("email", "website");
  }
  for (const p of phones) if (!p.核实) 待核.push("phones");
  if (名字) 记分("name", 名字.score);
  if (公司们[0]) 记分("company", 公司们[0].l.score);
  if (职位们[0]) 记分("title", 职位们[0].score);
  for (const [k, v] of Object.entries(来源分)) if (v < 0.9) 待核.push(k);
  // 名片语言线索：文字体系 > 区号 > 域名 > 国家；中英模型认不出的字常被认成「小写中间夹大写」的假拉丁（俄文）
  const 线索: string[] = [];
  if (主文字 && 主文字 !== "汉") 线索.push(主文字);
  for (const [re, lang] of 区号语言) if (re.test(全文)) 线索.push(lang);
  for (const [re, lang] of 域名语言) if (re.test(全文)) 线索.push(lang);
  if (country && 国家语言[country]) 线索.push(国家语言[country]);
  if (行们.filter((l) => 像假拉丁(l.text) >= 1).length >= 2) 线索.push("西里尔");
  let wa = phones.find((p) => p.类 === "WhatsApp");
  const 第一手机 = phones.find((p) => p.类 === "手机");
  // 名片上标了 WhatsApp、号码没标：用手机号（标签写的手机优先，其次号段是手机的；只有一个号码时就是它），标黄请人看一眼
  if (!wa && 标了WA) {
    const 可能 = 第一手机 ?? phones.find((p) => p.手机号段 && p.类 !== "传真") ?? (phones.length === 1 && phones[0].类 !== "传真" ? phones[0] : undefined);
    if (可能) { wa = 可能; 待核.push("whatsapp"); }
  }
  const pick = <T,>(xs: T[]) => (xs.length ? xs[0] : null);

  return {
    name: 名字 ? (韩.test(名字.rest) ? 名字.rest.replace(/\s+/g, "") : 清(名字.rest)) : null,
    nameAlt: 名字备.map((l) => 清(l.rest)),
    company: pick(公司们.map((x) => 修后缀(去头标签(拆词(x.l.rest))))),
    companyAlt: 公司们.slice(1).map((x) => 去头标签(x.l.rest)),
    title: pick(职位们.map((l) => 去头标签(拆词(l.rest)))),
    titleAlt: 职位们.slice(1).map((l) => 去头标签(l.rest)),
    phones,
    whatsapp: wa?.e164 ?? null,
    whatsapp建议: wa ? null : (第一手机?.e164 ?? null),
    wechat,
    email: pick(emails),
    website: pick(sites.filter((s) => !emails.some((e) => e.endsWith("@" + s) && false))),
    country,
    address,
    剩下: 去噪音(行们.filter((l) => !l.用 && l.rest), [公司们[0]?.l.rest ?? "", ...emails, ...sites], 公司们.map((x) => x.l)).map((l) => l.rest),
    待核: [...new Set(待核)],
    // 没人名的名片（只有公司）：建议用公司名，但公司那行得认得有把握，不然乱码会被建议成名字
    name建议: 名字 ? null : (公司们[0] && 公司们[0].l.score >= 0.85 ? 修后缀(去头标签(拆词(公司们[0].l.rest))) : null),
    语言线索: [...new Set(线索)],
  };
}

/** 中英模型没认好的框：置信度 < 阈值、至少 2 个字（1 个字的多半是 logo 图形） */
export function 低分框(框们: Omit<框, "side">[] | 框[], 阈 = 0.85) {
  return 框们.filter((b) => b.score < 阈 && b.text.trim().length >= 2);
}

/** 第二遍（换语言模型）和第一遍按位置配对：同一个框谁的置信度高用谁；第一遍漏掉的框补上 */
/** 一段文字里出现了哪些非拉丁、非汉字的文字体系 */
const 外文字 = (s: string) => [韩, 假名, 阿, 泰, 西里尔, 天城].filter((re) => re.test(s)).map((re) => re.source);

/**
 * 号码那一截还是用第一遍的：中英模型认数字很稳，语言模型常把号码的空格吃掉、丢几位（「هاتف567823411966+」）。
 * 第一遍 ≥ 7 位数字、两遍的数字不一样（连空格一起比）时，拿第一遍的号码配第二遍的字。
 */
function 号码用一(一: string, 二: string) {
  const 号 = /\+?[0-9][0-9\s()\-./]*[0-9]\+?/g;
  const 数 = (x: string) => x.replace(/\D/g, "");
  const 一号 = (统一(一).match(号) ?? []).filter((x) => 数(x).length >= 7);
  if (!一号.length) return 二;
  const 二统 = 统一(二);
  // 丢了位数：第一遍每个号码的后 7 位在第二遍里找不到；粘在一起：第二遍是 10 位以上没分隔的一长串，第一遍有空格
  const 丢了 = 一号.some((x) => !数(二统).includes(数(x).slice(-7)));
  const 粘了 = (二统.match(号) ?? []).some((x) => /^\+?\d{10,}\+?$/.test(x)) && 一号.some((x) => /\s/.test(x));
  if (!丢了 && !粘了) return 二;
  const 字 = 二统.replace(号, " ").replace(/\s+/g, " ").trim();
  // 阿拉伯文那行是从右往左的「视觉顺序」：号码在左边、标签在右边
  return 阿.test(二) ? `${一号.join(" ")} ${字}` : `${字} ${一号.join(" ")}`;
}

export function 合并两遍(一: 框[], 二: 框[]): 框[] {
  const 配 = (b: 框, 们: 框[]) => {
    let best: 框 | null = null, d0 = 0.6;
    for (const c of 们) {
      if (c.side !== b.side) continue;
      const d = Math.abs(c.cx - b.cx) / Math.max(b.w, 1) + Math.abs(c.cy - b.cy) / Math.max(b.h, 1);
      if (d < d0) { d0 = d; best = c; }
    }
    return best;
  };
  const 用过 = new Set<框>();
  const 出 = 一.map((b) => {
    const c = 配(b, 二);
    if (c) 用过.add(c);
    if (!c) return b;
    // 换的语言在这一框认出了自己的文字（俄文名字第一遍被认成「EneHa」还给了 0.90）：也用第二遍
    const 新文字 = 外文字(c.text).filter((k) => !外文字(b.text).includes(k));
    const 用二 = c.score > b.score || (新文字.length > 0 && c.score >= 0.8 && (b.score < 0.95 || 像假拉丁(统一(b.text)) >= 1));
    return 用二 ? { ...b, text: 号码用一(b.text, c.text), score: c.score } : b;
  });
  for (const c of 二) if (!用过.has(c) && c.score >= 0.8 && !配(c, 一)) 出.push(c);
  return 出;
}

/** 配对后第二遍在「第一遍低分框」上置信度的中位数：用来判断换的语言对不对 */
export function 低分框得分(一: 框[], 二: 框[], 阈 = 0.85) {
  const 低 = 低分框(一, 阈) as 框[];
  if (!低.length) return 0;
  const 分们: number[] = [];
  for (const b of 低) {
    let best = 0, d0 = 0.6;
    for (const c of 二) {
      if (c.side !== b.side) continue;
      const d = Math.abs(c.cx - b.cx) / Math.max(b.w, 1) + Math.abs(c.cy - b.cy) / Math.max(b.h, 1);
      if (d < d0) { d0 = d; best = c.score; }
    }
    分们.push(best);
  }
  // 取中位数：某一行换了语言也认不出来（阿拉伯-印度数字的号码行）不拖垮整张
  分们.sort((a, b) => a - b);
  const m = 分们.length >> 1;
  return 分们.length % 2 ? 分们[m] : (分们[m - 1] + 分们[m]) / 2;
}

/**
 * 没有任何线索（本地写法电话、.com 邮箱）时看低分框长什么样：韩文被中英模型认成一串生僻汉字（召包歪 / 告部量咎），
 * 低分框一半以上以汉字为主、又没有假名、整张也没有认得有把握的中文行 → 先试韩文。认成拉丁乱码的（阿拉伯 / 泰文都像）分不出来，留给人点。
 */
export function 低分框线索(框们: 框[]): string | null {
  const 低 = 低分框(框们) as 框[];
  if (低.length < 2) return null;
  const 数 = (t: string, re: RegExp) => (t.match(re) ?? []).length;
  // 真中文名片：总有认得有把握的中文行，这时不猜韩文
  if (框们.some((b) => b.score >= 0.9 && 数(b.text, /[㐀-鿿]/g) >= 3)) return null;
  const 像汉 = 低.filter((b) => !假名.test(b.text) && 数(b.text, /[㐀-鿿]/g) >= Math.max(1, 数(b.text, /[A-Za-z]/g))).length;
  return 像汉 * 2 >= 低.length ? "韩" : null;
}
