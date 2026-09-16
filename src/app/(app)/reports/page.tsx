import { redirect } from "next/navigation";

/**
 * 「数据复盘」并进了「数据」页（/overview）。
 *
 * 三处看数、两个问答框，新来的人分不清该去哪儿。这条 URL 留着不删——
 * 有人存了书签，也有链接从别处指过来——直接跳到合并后的「本年」视图。
 */
export default function ReportsPage() {
  redirect("/overview?view=本年");
}
