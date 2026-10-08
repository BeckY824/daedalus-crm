"use client";
import Shortcut from "./Shortcut";
import { 交给首页问 } from "@/lib/home-ask";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "antd";
import { SearchOutlined } from "@ant-design/icons";
import { useBusiness } from "@/lib/business-client";
import { 外贸订单 } from "@/lib/business-config";
import { 供应商页 } from "@/lib/features";
import { 换一位 } from "@/lib/roster";

/**
 * ⌘K。
 *
 * 一个键管两件事：**跳到哪一页**，和**问一句**。
 *   首页有问答框时，⌘K 就是把光标放回那个框——
 *   在那儿 ⌘K 的意思已经是「我要打字了」，再弹一个浮层等于多一步。
 *   其余页面 ⌘K 打开这张单子：打字筛页面，回车跳过去；
 *   一个页面都没匹配上时，第一条变成「问一句」，回车带着这句话去首页问。
 *
 * 快捷键要能被发现：左栏底部常驻一行「⌘K 跳转 / 提问」，这张单子底下也写着。
 * 藏起来的快捷键等于不存在。
 */
/** 焦点在输入框 / 文本域 / 可编辑区里。⌘N 这类「页面级」快捷键那时不该接管 */
function 在输入框里(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  return t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName);
}

export default function CommandBar({ 有AI }: { 有AI: boolean }) {
  const router = useRouter();
  const b = useBusiness();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);

  const 页面 = useMemo(
    () => [
      { 名: "首页", 去: "/dashboard", 说明: "问一句，或看今天要跟谁" },
      { 名: "数据", 去: "/overview", 说明: "现在 / 本月 / 本年" },
      { 名: "线索", 去: "/leads", 说明: "还没建档的人" },
      { 名: b.customer, 去: "/customers", 说明: "全部档案与跟进" },
      { 名: "渠道", 去: "/channels", 说明: "外部推荐来源" },
      { 名: "联系人", 去: "/contacts", 说明: b.fields.school === "院校" ? "家长、老师、经办人" : "客户那边对接的人" },
      { 名: "商机", 去: "/opportunities", 说明: "在谈的单子" },
      { 名: "商机管道", 去: "/opportunities/pipeline", 说明: "按阶段拖着看" },
      // 外贸模版的订单（2026-10-05）：左栏有，这里也要有
      ...(外贸订单(b) ? [{ 名: "订单", 去: "/orders", 说明: "客户确认的每一单" }] : []),
      // 供应商页开着时（lib/features.ts）左栏有，这里也要有（二审）
      ...(b.template === "trade" && 供应商页 ? [{ 名: "供应商", 去: "/suppliers", 说明: "工厂档案和比价" }] : []),
      { 名: "跟进记录", 去: "/follow-ups", 说明: "已经发生的沟通" },
      { 名: "跟进计划", 去: "/follow-ups/plans", 说明: "排好还没做的" },
      { 名: "设置", 去: "/settings", 说明: "成员、密码、AI 接入、业务配置" },
    ],
    [b],
  );

  const 命中 = useMemo(() => {
    const k = q.trim();
    if (!k) return 页面;
    return 页面.filter((p) => p.名.includes(k) || p.说明.includes(k));
  }, [q, 页面]);

  /** 一个页面都没匹配上：那这句话多半是个问题，不是页面名 */
  const 当问题 = q.trim().length >= 2 && 命中.length === 0;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      /*
        ⌘N：在当前页新建。它不知道每一页的新建长什么样，也不需要知道——
        页头右上角那个主按钮就是这一页的主动作（见 ui.tsx 的 PageHead），点它就是。
        页头上没有主按钮的页面（首页、数据）什么也不发生，这比弹一个「本页不支持」强。
        在输入框里打字时不接管：那时 ⌘N 该由浏览器或输入法处理。
      */
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n" && !在输入框里(e)) {
        const 主按钮 = document.querySelector<HTMLButtonElement>(".page-head-a button.ant-btn-primary:not([disabled])");
        if (主按钮) {
          e.preventDefault();
          主按钮.click();
        }
        return;
      }
      if (!((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")) return;
      e.preventDefault();
      /*
        这一页**自己**有问答框就把光标给它——那才是这一页的主动作。
        「自己的」要当真：0.38 起右边那块全局 AI 面板在每一页都摆了一个同款输入框，
        不排除它的话 ⌘K 在任何页面都只会去聚焦面板，跳转单再也弹不出来。
        ⌘K 和 ⌘J 是两件事：一个是「去哪儿 / 问一句」，一个是那块面板。
      */
      const 框 = [...document.querySelectorAll<HTMLTextAreaElement>(".cli-input textarea")].find((el) => !el.closest(".dock"));
      if (框 && !open) {
        框.focus();
        框.select();
        return;
      }
      // 记录页上 ⌘K 是「换一位」：名单登记过就交给它，不再和跳转单一起响（审查 M8）
      if (!open && 换一位()) return;
      setOpen((v) => !v);
      setQ("");
      setIdx(0);
    };
    window.addEventListener("keydown", onKey);
    // 左栏顶上那个搜索框点了：直接开跳转单（不走 ⌘K 那套「先给页内输入框」的分流——点的就是它）
    const onOpen = () => {
      setOpen(true);
      setQ("");
      setIdx(0);
    };
    window.addEventListener("cmdbar:open", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("cmdbar:open", onOpen);
    };
  }, [open]);

  function 走(i = idx) {
    if (当问题) {
      if (!有AI) return;
      // 带着问题去首页问：答案、过程、建议卡都在那儿，不在一个浮层里
      // 先说一声「这句是我交过去的」：首页只自动发本应用交过去的，外面来的链接只填进框里（J-158）
      交给首页问(q);
      router.push(`/dashboard?q=${encodeURIComponent(q.trim())}`);
    } else {
      const p = 命中[i];
      if (!p) return;
      router.push(p.去);
    }
    setOpen(false);
  }

  return (
    <Modal open={open} onCancel={() => setOpen(false)} footer={null} closable={false} width={520} styles={{ body: { padding: 0 } }}>
      <div className="cmdk">
        <div className="cmdk-in">
          <SearchOutlined />
          <input
            autoFocus
            value={q}
            placeholder="跳到哪一页，或者直接问一句"
            onChange={(e) => {
              setQ(e.target.value);
              setIdx(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIdx((i) => (i + 1) % Math.max(1, 命中.length));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIdx((i) => (i <= 0 ? 命中.length - 1 : i - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                走();
              } else if (e.key === "Escape") {
                // 标记成「处理过了」：底下首页那句「Esc 打断回答」看到它就不再接（lib/esc.ts）
                e.preventDefault();
                setOpen(false);
              }
            }}
          />
        </div>
        <div className="cmdk-list">
          {当问题 ? (
            <button type="button" className="cmdk-row cmdk-row-on" disabled={!有AI} onClick={() => 走()}>
              <b>{有AI ? "问一句" : "尚未接入 AI"}</b>
              <span>{有AI ? `「${q.trim()}」——去首页问，它会读完记录再答` : "问题保留在输入框中。在设置中接入 AI，或联系工作区管理员后再提问。"}</span>
            </button>
          ) : (
            命中.map((p, i) => (
              <button key={p.去} type="button" className={`cmdk-row${i === idx ? " cmdk-row-on" : ""}`} onClick={() => 走(i)} onMouseEnter={() => setIdx(i)}>
                <b>{p.名}</b>
                <span>{p.说明}</span>
              </button>
            ))
          )}
        </div>
        <div className="cmdk-foot">
          <kbd>↑↓</kbd> 选 · <kbd>↵</kbd> 去 · <kbd>Esc</kbd> 关 · 首页有问答框时 <kbd><Shortcut>⌘K</Shortcut></kbd> 回到输入框，在{b.customer}记录页换一位，其余页面打开跳转单
        </div>
      </div>
    </Modal>
  );
}
