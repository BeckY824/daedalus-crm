"use client";

import { useEffect, useRef, useState } from "react";
import { Form, Select } from "antd";
import { useBusiness } from "@/lib/business-client";
import { FOLLOW_TYPE_MAP } from "@/lib/constants";
import { smartTime } from "@/lib/utils";
import { 截止说法 } from "@/lib/deadline";
import { 搜客户, 取客户近况, type 可挑客户, type 客户近况 } from "./pick";

export type { 客户近况 };

/**
 * 计划 / 跟进表单在列表页上用时的第一格：先挑人（2026-09-29）。
 *
 * 记录页上已经知道是谁，不出这一格；列表页上「新建计划」「记录跟进」就地弹框，
 * 第一格挑人，挑中之后紧跟一行淡字：上次跟进、还欠着的计划——
 * 原来跳去记录页就是为了看这个（「那儿才知道上次谈到哪儿」），现在它跟着人进框里。
 *
 * 搜索走服务端（pick.ts），客户上千也不会一打开就拉全表。
 * 近况由表单持有：跟进表单还要拿里面的联系人、商机和到期计划。
 */
export default function CustomerPick({
  预选,
  近况,
  on近况,
  给计划,
  不提计划,
}: {
  /** 从某位客户带过来的（地址栏 ?customer=）：预填这一位 */
  预选?: { id: string; name: string } | null;
  近况: 客户近况 | null;
  on近况: (v: 客户近况 | null) => void;
  /** 计划表单：已有没做完的计划时要说清楚「这条另加，不替换它」 */
  给计划?: boolean;
  /** 跟进表单里那条到期计划底下已经有「同时完成」一格，这一行就不再重复说它 */
  不提计划?: boolean;
}) {
  const b = useBusiness();
  const [候选, set候选] = useState<可挑客户[]>(预选 ? [{ ...预选, 附注: null }] : []);
  const [搜着, set搜着] = useState(false);
  /** 最后一次搜的字：空着也搜不出人，说明库里还没有客户，那句话得换 */
  const [搜的词, set搜的词] = useState("");
  /** 只认最后一次：打字快的时候，先发的请求可能后回来，不能拿旧结果盖掉新的 */
  const 搜次 = useRef(0);
  const 取次 = useRef(0);
  const 计时 = useRef<ReturnType<typeof setTimeout> | null>(null);

  function 搜(词: string) {
    const 次 = ++搜次.current;
    set搜着(true);
    set搜的词(词.trim());
    void 搜客户(词)
      .then((rows) => {
        if (次 !== 搜次.current) return;
        // 已经挑中的那位留在候选里：不然搜别的字时，框里显示的会变成一串 id
        set候选((旧) => {
          const 挑中 = 近况 ?? 旧.find((c) => c.id === 预选?.id);
          return 挑中 && !rows.some((r) => r.id === 挑中.id) ? [{ id: 挑中.id, name: 挑中.name, 附注: null }, ...rows] : rows;
        });
      })
      .finally(() => {
        if (次 === 搜次.current) set搜着(false);
      });
  }

  function 取(id: string | undefined) {
    const 次 = ++取次.current;
    on近况(null);
    if (!id) return;
    void 取客户近况(id).then((v) => {
      if (次 === 取次.current) on近况(v);
    });
  }

  // 一打开先给最近跟进过的几位（多半就是要记的那一位）；带着预选的顺手取它的近况。
  // 弹窗关掉内容就销毁（destroyOnHidden），所以每次打开都重来一遍
  useEffect(() => {
    // 放到下一拍：搜的时候要置「搜着」，不在 effect 里同步 setState
    const 开头 = setTimeout(() => {
      搜("");
      if (预选) 取(预选.id);
    }, 0);
    // 关框之后还在路上的请求一律作废：不然它回来会把上一位的近况塞给下次打开的框
    const 搜的 = 搜次, 取的 = 取次, 表 = 计时;
    return () => {
      clearTimeout(开头);
      if (表.current) clearTimeout(表.current);
      搜的.current++;
      取的.current++;
    };
    // 只在挂载时跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Form.Item
      name="customerId"
      label={b.customer}
      initialValue={预选?.id}
      rules={[{ required: true, message: `先挑一位${b.customer}` }]}
      extra={<近况行 近况={近况} 给计划={给计划} 不提计划={不提计划} />}
    >
      <Select
        autoFocus
        allowClear
        placeholder={`搜名字 / ${b.fields.school} / 电话`}
        showSearch={{
          filterOption: false,
          onSearch: (词) => {
            if (计时.current) clearTimeout(计时.current);
            计时.current = setTimeout(() => 搜(词), 200);
          },
        }}
        loading={搜着}
        notFoundContent={搜着 ? "正在找…" : 搜的词 ? `没有对得上的${b.customer}` : `还没有${b.customer}，先去${b.customer}页建一位`}
        options={候选.map((c) => ({ value: c.id, label: c.name, 附注: c.附注 }))}
        optionRender={(o) => (
          <span className="pick-opt">
            <span>{o.label}</span>
            {o.data.附注 && <span className="pick-opt-n">{o.data.附注}</span>}
          </span>
        )}
        onChange={(id?: string) => 取(id)}
      />
    </Form.Item>
  );
}

/**
 * 挑中之后的那行淡字。没挑之前也占着这一行、先说一句它是干什么的：
 * 空着一截像是排版坏了；挑中再冒出来，又会把下面整张表往下推一下。
 */
function 近况行({ 近况, 给计划, 不提计划 }: { 近况: 客户近况 | null; 给计划?: boolean; 不提计划?: boolean }) {
  if (!近况) return <span className="pick-ctx pick-ctx-0">挑好之后，这里会写上次谈到哪儿</span>;
  const f = 近况.上次跟进;
  const p = 近况.未完成计划;
  const 方式 = f ? FOLLOW_TYPE_MAP[f.type]?.label ?? f.type : "";
  // 标题空着就拿内容开头顶上；标题和方式一样（「线上会议 · 线上会议」）就不重复
  const 标题 = f ? f.title || f.content.slice(0, 24) + (f.content.length > 24 ? "…" : "") : "";
  return (
    <span className="pick-ctx" aria-live="polite">
      <span>
        {f ? (
          <>上次跟进 {smartTime(f.occurredAt)} · {方式}{标题 && 标题 !== 方式 && ` · ${标题}`}</>
        ) : (
          "还没跟进过"
        )}
      </span>
      {p && !不提计划 && (
        <span>
          还有计划「{p.subject}」· {截止说法(p.plannedAt)}
          {近况.未完成计划数 > 1 && ` 等 ${近况.未完成计划数} 条`}
          {/* savePlan 不带 id 永远是新建一条，不会顶掉旧的——框里要明说，别让人以为改了原来那条 */}
          {给计划 && "，这条另加，不替换它"}
        </span>
      )}
    </span>
  );
}
