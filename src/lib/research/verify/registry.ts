/**
 * 官方工商库和税号（方案 2.1.1，只接免费的）：
 *   英国  Companies House：要 key（COMPANIES_HOUSE_API_KEY）。**key 要用户自己去注册**，没配就跳过、报告里写明
 *   法国  recherche-entreprises.api.gouv.fr：免费、不用 key
 *   挪威  Brønnøysund（data.brreg.no）：免费、不用 key
 *   全球  GLEIF（LEI 码库）：免费、不用 key。覆盖面窄（做过金融交易登记的才有），查到就很可信；
 *         德国这类没有官方接口的国家，常能从这里查到 HRB 号（10-18 实测 SLV GmbH → HRB 9712）
 *   欧盟  VIES 增值税号校验：对方给了税号才查。德国、西班牙只回「有效 / 无效」不回名字；
 *         对方国家的系统挂了是「查不了」，和「无效」分开
 * 第三期（10-18）再接几个免费、不用 key 的：
 *   芬兰  PRH 开放数据（avoindata.prh.fi）
 *   捷克  ARES（ares.gov.cz）
 *   美国  SEC EDGAR：只收向 SEC 申报的公司（上市 / 发债），没查到不扣分
 *   波兰  财政部增值税白名单（wl-api.mf.gov.pl）：没有按名字查的免费官方库，对方给了波兰税号才按 NIP 查
 * 付费的（荷兰 KvK、OpenCorporates……）一律不接。丹麦 CVR、澳大利亚 ABN 这类免费但要注册账号的也先不接。
 *
 * 认「是不是这家」用 names.ts 的 比名字：一字不差的「同」优先，其次「近」。**已注销只在「同」、并且没有同名存续的时候才标红**。
 */
import { 取JSON, 查不了 } from "./net";
import { 比名字, 查询名, type 像不像 } from "./names";
import { 国名 } from "./country";
import type { 核验项, 核验链接 } from "./types";

export type 登记 = {
  库: string;
  名: string;
  号: string;
  存续: boolean;
  成立?: string;
  地址?: string;
  国?: string;
  链: string;
  像: Exclude<像不像, null>;
  /** 库里不记存续 / 注销的（SEC EDGAR）：句子里写这个，不写「存续」 */
  状态?: string;
};

type 查库 = (名: string, signal?: AbortSignal) => Promise<登记[]>;

/** 同名的里挑：同 > 近；存续 > 注销 */
export function 挑登记(候选: 登记[]): 登记 | undefined {
  const 分 = (x: 登记) => (x.像 === "同" ? 2 : 0) + (x.存续 ? 1 : 0);
  return [...候选].sort((a, b) => 分(b) - 分(a))[0];
}

function 留像的<T extends { 名: string }>(列: T[], 公司: string): (T & { 像: Exclude<像不像, null> })[] {
  return 列.flatMap((x) => {
    const 像 = 比名字(公司, x.名);
    return 像 ? [{ ...x, 像 }] : [];
  });
}

export const 英国库: (key: string) => 查库 = (key) => async (名, signal) => {
  type R = { items?: { title: string; company_number: string; company_status?: string; date_of_creation?: string; address_snippet?: string }[] };
  const r = await 取JSON<R>(`https://api.company-information.service.gov.uk/search/companies?q=${encodeURIComponent(名)}&items_per_page=8`, {
    秒: 8,
    signal,
    headers: { Authorization: `Basic ${Buffer.from(`${key}:`).toString("base64")}` },
  });
  if (r.status === 401) throw new 查不了("Companies House 的 key 不对");
  return 留像的(
    (r.data?.items ?? []).map((x) => ({
      库: "英国 Companies House",
      名: x.title,
      号: x.company_number,
      存续: !["dissolved", "liquidation", "converted-closed", "removed", "closed"].includes(x.company_status ?? ""),
      成立: x.date_of_creation,
      地址: x.address_snippet,
      国: "GB",
      链: `https://find-and-update.company-information.service.gov.uk/company/${x.company_number}`,
    })),
    名,
  );
};

export const 法国库: 查库 = async (名, signal) => {
  type R = { results?: { nom_complet: string; nom_raison_sociale?: string; siren: string; etat_administratif?: string; date_creation?: string; siege?: { adresse?: string } }[] };
  const r = await 取JSON<R>(`https://recherche-entreprises.api.gouv.fr/search?q=${encodeURIComponent(名)}&per_page=8`, { 秒: 8, signal });
  return 留像的(
    (r.data?.results ?? []).map((x) => ({
      库: "法国企业名录（recherche-entreprises）",
      名: x.nom_raison_sociale || x.nom_complet,
      号: `SIREN ${x.siren}`,
      存续: x.etat_administratif !== "C",
      成立: x.date_creation,
      地址: x.siege?.adresse,
      国: "FR",
      链: `https://annuaire-entreprises.data.gouv.fr/entreprise/${x.siren}`,
    })),
    名,
  );
};

export const 挪威库: 查库 = async (名, signal) => {
  type R = { _embedded?: { enheter?: { navn: string; organisasjonsnummer: string; stiftelsesdato?: string; registreringsdatoEnhetsregisteret?: string; konkurs?: boolean; underAvvikling?: boolean; underTvangsavviklingEllerTvangsopplosning?: boolean; slettedato?: string; forretningsadresse?: { adresse?: string[]; poststed?: string } }[] } };
  const r = await 取JSON<R>(`https://data.brreg.no/enhetsregisteret/api/enheter?navn=${encodeURIComponent(名)}&size=8`, { 秒: 8, signal });
  return 留像的(
    (r.data?._embedded?.enheter ?? []).map((x) => ({
      库: "挪威 Brønnøysund 登记中心",
      名: x.navn,
      号: `Org.nr ${x.organisasjonsnummer}`,
      存续: !(x.konkurs || x.underAvvikling || x.underTvangsavviklingEllerTvangsopplosning || x.slettedato),
      成立: x.stiftelsesdato ?? x.registreringsdatoEnhetsregisteret,
      地址: [...(x.forretningsadresse?.adresse ?? []), x.forretningsadresse?.poststed].filter(Boolean).join(", ") || undefined,
      国: "NO",
      链: `https://virksomhet.brreg.no/nb/oppslag/enheter/${x.organisasjonsnummer}`,
    })),
    名,
  );
};

export const GLEIF库: 查库 = async (名, signal) => {
  type R = { data?: { attributes: { lei: string; entity: { legalName: { name: string }; status?: string; legalAddress?: { country?: string; city?: string }; creationDate?: string; registeredAs?: string }; registration?: { status?: string } } }[] };
  const r = await 取JSON<R>(`https://api.gleif.org/api/v1/lei-records?filter[fulltext]=${encodeURIComponent(名)}&page[size]=10`, { 秒: 8, signal, headers: { Accept: "application/vnd.api+json" } });
  return 留像的(
    (r.data?.data ?? []).map(({ attributes: a }) => ({
      库: "GLEIF（全球 LEI 码库）",
      名: a.entity.legalName.name,
      号: a.entity.registeredAs ? `${a.entity.registeredAs}（LEI ${a.lei}）` : `LEI ${a.lei}`,
      存续: a.entity.status !== "INACTIVE",
      成立: a.entity.creationDate?.slice(0, 10),
      地址: a.entity.legalAddress?.city,
      国: a.entity.legalAddress?.country,
      链: `https://search.gleif.org/#/record/${a.lei}`,
    })),
    名,
  );
};

/* ---- 第三期（2026-10-18）：再接几个免费、不用 key 的官方库，按出口客户常见的国家挑 ---- */

export const 芬兰库: 查库 = async (名, signal) => {
  type 名字 = { name: string; type: string; endDate?: string };
  type R = { companies?: { businessId: { value: string; registrationDate?: string }; names?: 名字[]; endDate?: string; tradeRegisterStatus?: string; registrationDate?: string; addresses?: { street?: string; postCode?: string; postOffices?: { city?: string }[] }[] }[] };
  const r = await 取JSON<R>(`https://avoindata.prh.fi/opendata-ytj-api/v3/companies?name=${encodeURIComponent(名)}`, { 秒: 8, signal });
  return 留像的(
    (r.data?.companies ?? []).slice(0, 20).flatMap((x) => {
      // type 1 是正式名（3 是副名）；注销了的公司名字也带 endDate，取最后那个
      const 正 = (x.names ?? []).filter((n) => n.type === "1");
      const 名字 = (正.find((n) => !n.endDate) ?? 正.at(-1))?.name;
      if (!名字) return [];
      const 址 = x.addresses?.[0];
      return [
        {
          库: "芬兰 PRH 企业登记（YTJ）",
          名: 名字,
          号: `Y-tunnus ${x.businessId.value}`,
          存续: !x.endDate && x.tradeRegisterStatus !== "4",
          成立: x.registrationDate ?? x.businessId.registrationDate,
          地址: [址?.street, 址?.postOffices?.[0]?.city].filter(Boolean).join(", ") || undefined,
          国: "FI",
          链: `https://tietopalvelu.ytj.fi/yritys/${x.businessId.value}`,
        },
      ];
    }),
    名,
  );
};

export const 捷克库: 查库 = async (名, signal) => {
  type R = { kod?: string; subKod?: string; ekonomickeSubjekty?: { ico: string; obchodniJmeno: string; datumVzniku?: string; datumZaniku?: string; sidlo?: { textovaAdresa?: string } }[] };
  const r = await 取JSON<R>("https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/vyhledat", { 秒: 8, signal, 方法: "POST", body: { obchodniJmeno: 名, pocet: 10 } });
  // 名字太常见（ARES 一次最多回 1000 条，超了直接报错）：不能说「没查到」
  if (r.data?.subKod === "VYSTUP_PRILIS_MNOHO_VYSLEDKU") throw new 查不了("名字太常见，捷克 ARES 回的结果太多");
  return 留像的(
    (r.data?.ekonomickeSubjekty ?? []).map((x) => ({
      库: "捷克 ARES 经济主体登记",
      名: x.obchodniJmeno,
      号: `IČO ${x.ico}`,
      存续: !x.datumZaniku,
      成立: x.datumVzniku,
      地址: x.sidlo?.textovaAdresa,
      国: "CZ",
      链: `https://ares.gov.cz/ekonomicke-subjekty?ico=${x.ico}`,
    })),
    名,
  );
};

export let 美国重试毫秒 = 1000;
/** 测试用 */
export function 设美国重试毫秒(n: number) {
  美国重试毫秒 = n;
}

/** 美国 SEC EDGAR：只收上市 / 发债、向 SEC 申报的公司（多数美国进口商是私人公司，不在里面） */
export const 美国库: 查库 = async (名, signal) => {
  type R = { hits?: { hits?: { _id: string; _source: { entity: string } }[] } };
  const url = `https://efts.sec.gov/LATEST/search-index?keysTyped=${encodeURIComponent(名)}`;
  // 10-18 实测偶尔回一次 500、马上再查就好：隔一秒重试一次
  const r = await 取JSON<R>(url, { 秒: 8, signal }).catch(async (e: unknown) => {
    if (!(e instanceof 查不了)) throw e;
    await new Promise((ok) => setTimeout(ok, 美国重试毫秒));
    return 取JSON<R>(url, { 秒: 8, signal });
  });
  return 留像的(
    (r.data?.hits?.hits ?? []).map((x) => {
      const cik = x._id.replace(/\D/g, "");
      return {
        库: "美国 SEC EDGAR",
        // 名字后面常带「(CIK 0001144215)」「, Inc. (DE)」这类尾巴，比名字前去掉括号
        名: x._source.entity.replace(/\s*\([^)]*\)\s*$/g, "").trim(),
        号: `CIK ${cik}`,
        存续: true,
        状态: "在 SEC 有申报记录",
        国: "US",
        链: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}`,
      };
    }),
    名,
  );
};

/**
 * 波兰：没有免费的按名字查的官方库；财政部的「增值税纳税人白名单」（Biała lista）能按税号（NIP）查到登记名、
 * 状态、注册日期、KRS 号。对方给了波兰税号才查；回来的银行账号、代表人姓名一律不用。
 */
export function 波兰库(nip: string): 查库 {
  let 一次: Promise<Omit<登记, "像">[]> | null = null;
  return (名, signal) => {
    const 查 = (一次 ??= (async () => {
      type R = { result?: { subject?: { name: string; nip: string; krs?: string | null; statusVat?: string; residenceAddress?: string | null; workingAddress?: string | null; registrationLegalDate?: string | null; removalDate?: string | null } | null } };
      const 今 = new Date().toISOString().slice(0, 10);
      const r = await 取JSON<R>(`https://wl-api.mf.gov.pl/api/search/nip/${nip}?date=${今}`, { 秒: 8, signal });
      const s = r.data?.result?.subject;
      if (!s) return [];
      return [
        {
          库: "波兰财政部增值税白名单（Biała lista）",
          名: s.name,
          号: `NIP ${s.nip}${s.krs ? `，KRS ${s.krs}` : ""}`,
          存续: !s.removalDate,
          成立: s.registrationLegalDate ?? undefined,
          地址: s.workingAddress ?? s.residenceAddress ?? undefined,
          国: "PL",
          链: "https://www.podatki.gov.pl/wykaz-podatnikow-vat-wyszukiwarka",
        },
      ];
    })());
    return 查.then((列) => 留像的(列, 名));
  };
}

/** 哪些国家有能直查的官方库。英国要 key */
export function 国家库(
  国家: string | undefined,
  env: Record<string, string | undefined> = process.env,
  税号?: string,
): { 库?: 查库; 名?: string; 缺key?: boolean; 缺税号?: boolean; 不全?: boolean } {
  if (国家 === "GB") {
    const key = env.COMPANIES_HOUSE_API_KEY?.trim();
    return key ? { 库: 英国库(key), 名: "英国 Companies House" } : { 名: "英国 Companies House", 缺key: true };
  }
  if (国家 === "FR") return { 库: 法国库, 名: "法国企业名录" };
  if (国家 === "NO") return { 库: 挪威库, 名: "挪威登记中心" };
  if (国家 === "FI") return { 库: 芬兰库, 名: "芬兰 PRH 企业登记" };
  if (国家 === "CZ") return { 库: 捷克库, 名: "捷克 ARES" };
  // 不全：库里只有一部分公司，没查到不能当疑点
  if (国家 === "US") return { 库: 美国库, 名: "美国 SEC EDGAR", 不全: true };
  if (国家 === "PL") {
    const v = 税号 ? 认税号(税号) : null;
    return v?.国 === "PL" && /^\d{10}$/.test(v.号) ? { 库: 波兰库(v.号), 名: "波兰增值税白名单" } : { 名: "波兰增值税白名单", 缺税号: true };
  }
  return {};
}

const 句 = (x: 登记) => `${x.库}：${x.名}，${x.号}，${x.状态 ?? (x.存续 ? "存续" : "已注销 / 解散")}${x.成立 ? `，${x.成立.slice(0, 10)} 成立` : ""}${x.地址 ? `，${x.地址}` : ""}`;

export async function 查工商(
  公司们: string[],
  国家: string | undefined,
  opts: { signal?: AbortSignal; env?: Record<string, string | undefined>; GLEIF?: 查库; 税号?: string } = {},
): Promise<核验项> {
  const 名们 = [...new Set(公司们.map(查询名).filter((n) => n.length >= 2))].slice(0, 2);
  if (!名们.length) return { key: "registry", 灯: "gray", 态: "不适用", 事实: "没有能拿去查的公司名" };
  const 本国 = 国家库(国家, opts.env, opts.税号);
  const 查 = async (库: 查库) => {
    const 出: 登记[] = [];
    for (const n of 名们) 出.push(...(await 库(n, opts.signal)));
    return 出;
  };
  const [国结果, 全球] = await Promise.all([
    本国.库 ? 查(本国.库).catch((e: unknown) => (e instanceof 查不了 ? e : Promise.reject(e))) : null,
    查(opts.GLEIF ?? GLEIF库).catch((e: unknown) => (e instanceof 查不了 ? e : Promise.reject(e))),
  ]);
  // GLEIF 按国家筛：知道国家的只认那个国家的（同名公司全世界都有）
  const 全球的 = Array.isArray(全球) ? 全球.filter((x) => !国家 || !x.国 || x.国 === 国家) : [];
  const 本国的 = Array.isArray(国结果) ? 国结果 : [];
  const 选 = 挑登记(本国的) ?? 挑登记(全球的);
  const 缺key注 = 本国.缺key ? `（${本国.名}没配 key，跳过）` : "";
  if (选) {
    const 同名存续 = [...本国的, ...全球的].some((x) => x.像 === "同" && x.存续);
    const 链接: 核验链接[] = [{ title: `${选.库}：${选.名}`, url: 选.链 }];
    if (!选.存续 && 选.像 === "同" && !同名存续) {
      return { key: "registry", 灯: "red", 态: "已核", 事实: `${句(选)}${缺key注}`, 硬红: `工商库显示已注销 / 解散（${选.库}：${选.名}）`, 链接 };
    }
    // 只是名字像（多几个词）、或者登记的国家和认出来的不一样：标黄，让人看一眼是不是这家
    const 黄 = !选.存续 || 选.像 === "近" || (国家 && 选.国 && 选.国 !== 国家);
    return { key: "registry", 灯: 黄 ? "yellow" : "green", 态: "已核", 事实: `${句(选)}${选.像 === "近" ? "（名字不完全一样，请确认是不是这家）" : ""}${缺key注}`, 链接 };
  }
  const 挂 = [国结果, 全球].filter((x) => x instanceof 查不了).length;
  if (本国.库) {
    // 库名以西文结尾（「SEC EDGAR」）的，和后面的中文之间空一格
    const 名接 = `${本国.名}${/[A-Za-z]$/.test(本国.名 ?? "") ? " " : ""}`;
    if (国结果 instanceof 查不了) return { key: "registry", 灯: "gray", 态: "查不了", 事实: `${名接}这会儿查不了（${国结果.message}）` };
    if (本国.不全) return { key: "registry", 灯: "gray", 态: "不适用", 事实: `${名接}和 GLEIF 里都没查到「${名们.join("」「")}」。美国没有全国统一的工商库，EDGAR 只收上市、发债这类向 SEC 申报的公司，私人公司查不到很正常，不扣分` };
    return { key: "registry", 灯: "yellow", 态: "没查到", 事实: `${名接}和 GLEIF 里都没查到「${名们.join("」「")}」` };
  }
  if (挂 && !本国.缺key) return { key: "registry", 灯: "gray", 态: "查不了", 事实: "GLEIF 这会儿查不了；这个国家没有能直查的官方库" };
  const 国字 = 国家 ? 国名(国家) : "这家公司所在国";
  return {
    key: "registry",
    灯: "gray",
    态: "不适用",
    事实: 本国.缺key
      ? `${本国.名} 还没接上（缺查询 key），这一项跳过；GLEIF 里也没查到`
      : 本国.缺税号
        ? `波兰的官方库要拿税号（NIP）查，对方没给波兰税号，这一项跳过；GLEIF 里也没查到`
        : `${国字}没有能直查的官方工商库，GLEIF 里也没有；登记信息以下面网页搜索的为准`,
  };
}

/* ---------------- 税号（VIES） ---------------- */

const 欧盟国 = new Set("AT BE BG CY CZ DE DK EE EL ES FI FR HR HU IE IT LT LU LV MT NL PL PT RO SE SI SK XI".split(" "));

/** 「DE 123 456 789」「de123456789」→ { 国: "DE", 号: "123456789" }；希腊用 EL；不是欧盟税号 null */
export function 认税号(s: string): { 国: string; 号: string } | null {
  const t = s.replace(/[\s.\-]/g, "").toUpperCase();
  const m = /^([A-Z]{2})([0-9A-Z]{2,13})$/.exec(t);
  if (!m) return null;
  const 国 = m[1] === "GR" ? "EL" : m[1];
  return 欧盟国.has(国) ? { 国, 号: m[2] } : null;
}

export async function 查税号(税号: string | undefined, 公司: string, signal?: AbortSignal): Promise<核验项> {
  if (!税号?.trim()) return { key: "vat", 灯: "gray", 态: "没提供", 事实: "没提供税号，未查" };
  const v = 认税号(税号);
  if (!v) return { key: "vat", 灯: "yellow", 态: "已核", 事实: `${税号} 不是欧盟增值税号的格式（应该是国家两位字母加号码，比如 DE123456789）` };
  type R = { isValid?: boolean; userError?: string; name?: string; address?: string };
  let r: { status: number; data: R | null };
  try {
    r = await 取JSON<R>(`https://ec.europa.eu/taxation_customs/vies/rest-api/ms/${v.国}/vat/${encodeURIComponent(v.号)}`, { 秒: 10, signal });
  } catch (e) {
    if (e instanceof 查不了) return { key: "vat", 灯: "gray", 态: "查不了", 事实: `欧盟 VIES 这会儿查不了（${e.message}），不代表税号无效` };
    throw e;
  }
  const 链接 = [{ title: "欧盟 VIES 税号校验", url: "https://ec.europa.eu/taxation_customs/vies/#/vat-validation" }];
  const 错 = r.data?.userError ?? "";
  if (r.data?.isValid) {
    const 名 = r.data.name && r.data.name !== "---" ? r.data.name.trim() : "";
    const 对不上 = 名 && !比名字(公司, 名);
    return {
      key: "vat",
      灯: 对不上 ? "yellow" : "green",
      态: "已核",
      事实: `${v.国}${v.号}：有效${名 ? `，登记名「${名}」${对不上 ? "，和这家的名字对不上" : ""}` : `（${v.国 === "DE" || v.国 === "ES" ? "这个国家" : "对方系统"}不回公司名）`}`,
      链接,
    };
  }
  if (/UNAVAILABLE|TIMEOUT|MAX_CONCURRENT|SERVICE/.test(错) || !r.data) return { key: "vat", 灯: "gray", 态: "查不了", 事实: `${v.国} 的税号系统这会儿查不了（${错 || r.status}），不代表无效`, 链接 };
  return { key: "vat", 灯: "yellow", 态: "已核", 事实: `${v.国}${v.号}：VIES 显示无效`, 链接 };
}
