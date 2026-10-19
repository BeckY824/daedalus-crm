"use client";

/**
 * 录入弹窗的三条规矩（2026-10-19 客户反馈「新建客户 / 新建商机填到一半点框外面，弹窗没了，要重填」）：
 *
 * 1. 点遮罩不关。antd 弹窗默认点外面就关，填了一半的东西一下全没了
 * 2. Esc / 右上角 X / 「取消」关的时候，人填过东西就先问一句「放弃填的内容？」
 * 3. 新建弹窗没保存就关的，草稿留在这台电脑上（localStorage），下次打开同一个新建弹窗接着填；保存成功就清掉
 *
 * 「填过」只认人亲手改的（Form 的 onValuesChange 只在人操作时触发，程序 setFieldsValue 不算）——
 * 打开时程序填进去的默认值（负责人、跟进类型……）不算填过，没动就关不用问（同 PlanForm 人改过方式 那条坑）。
 *
 * 草稿只存这台电脑、只按人分（换个账号登录看不到上一个人的草稿），放 7 天，过了当没有。
 * 编辑弹窗不存草稿：那条记录本来就在库里，草稿和库里的新值一比反而说不清该信谁。
 */
import { useCallback, useEffect, useRef } from "react";
import { App, Button, Space } from "antd";
import type { FormInstance } from "antd";
import { dayjs } from "@/lib/utils";
import { useMe } from "@/lib/me-client";

const 前缀 = "daedalus:草稿:";
const 放几天 = 7;

type 存的 = { at: number; v: unknown };

/** dayjs 存成 { $d: ISO }，读回来再变回 dayjs——日期格（预计签约、下次跟进）存进 JSON 会变成字符串，DatePicker 认不得 */
function 写成串(v: unknown): string {
  return JSON.stringify({ at: Date.now(), v }, function (this: Record<string, unknown>, k, x) {
    const 原 = this[k];
    return dayjs.isDayjs(原) ? { $d: 原.toISOString() } : x;
  });
}

function 读回来(raw: string): 存的 | null {
  try {
    const r = JSON.parse(raw, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) && Object.keys(x).length === 1 && typeof x.$d === "string" ? dayjs(x.$d) : x)) as 存的;
    return r && typeof r.at === "number" ? r : null;
  } catch {
    return null;
  }
}

export function 草稿全名(我: string | null | undefined, 键: string): string {
  return `${前缀}${我 ?? "-"}:${键}`;
}

export function 读草稿(全名: string): Record<string, unknown> | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(全名);
  } catch {
    return null;
  }
  const r = raw ? 读回来(raw) : null;
  if (!r || Date.now() - r.at > 放几天 * 86400_000 || !r.v || typeof r.v !== "object") return null;
  return r.v as Record<string, unknown>;
}

export function 存草稿(全名: string, v: unknown): void {
  try {
    localStorage.setItem(全名, 写成串(v));
  } catch {
    /* 隐私模式、配额满：存不下就算了，规矩 1、2 照样管用 */
  }
}

export function 清草稿(全名: string): void {
  try {
    localStorage.removeItem(全名);
  } catch {
    /* 同上 */
  }
}

/** 有没有一格是人真填了东西的：空串、空数组、null 不算。只拿来判断要不要存草稿 */
export function 有内容(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === "string") return v.trim() !== "";
  if (Array.isArray(v)) return v.some(有内容);
  if (dayjs.isDayjs(v)) return true;
  if (typeof v === "object") return Object.values(v as Record<string, unknown>).some(有内容);
  return true;
}

export type 守卫选项 = {
  open: boolean;
  /** 关掉弹窗（原来 onCancel 里做的事） */
  关: () => void;
  /** antd 表单。没有表单的（完成计划小框这种 useState 的）不给，用 填过 自己说 */
  form?: FormInstance;
  /** 新建弹窗才给：同一个键就是「同一个新建弹窗」。编辑给 null，不存草稿 */
  草稿键?: string | null;
  /** 没有 antd 表单的弹窗自己说填没填过 */
  填过?: () => boolean;
  /** 正在保存的时候不让关（原来有的照旧） */
  忙?: boolean;
  /** 弹窗原来的 afterOpenChange（多半是 聚焦首项），照样调 */
  afterOpenChange?: (开了: boolean) => void;
  /** 不进草稿的格子：跟着挑中那位客户走的（客户、联系人、商机），下次打开重新挑 */
  不存?: readonly string[];
};

export function useFormGuard({ open, 关, form, 草稿键 = null, 填过, 忙 = false, afterOpenChange, 不存 }: 守卫选项) {
  const { modal, message } = App.useApp();
  const 我 = useMe();
  const 全名 = 草稿键 ? 草稿全名(我?.id, 草稿键) : null;
  const 改过 = useRef(false);
  const 问着 = useRef(false);
  const 不存键 = (不存 ?? []).join("|");
  const 取值 = useCallback(() => {
    const v = { ...(form?.getFieldsValue(true) as Record<string, unknown> | undefined) };
    for (const k of 不存键 ? 不存键.split("|") : []) delete v[k];
    return v;
  }, [form, 不存键]);

  // 草稿在打开那一刻就读好：等动画走完再读的话，人手快、动画没走完就开始填，读到的是自己刚填的这几个字
  const 待恢复 = useRef<Record<string, unknown> | null>(null);
  // 每次打开从头算：上一次改过没保存的，这一次没动就不该问
  useEffect(() => {
    if (!open) return;
    改过.current = false;
    待恢复.current = 全名 && form ? 读草稿(全名) : null;
  }, [open, 全名, form]);

  const 改了 = useCallback(() => {
    改过.current = true;
    if (!全名 || !form) return;
    const v = 取值();
    if (有内容(v)) 存草稿(全名, v);
  }, [全名, form, 取值]);

  /** 保存成功以后调：草稿清掉，关的时候不再问 */
  const 存好了 = useCallback(() => {
    改过.current = false;
    if (全名) 清草稿(全名);
  }, [全名]);

  const 开好了 = useCallback(
    (开了: boolean) => {
      // 动画走完、各弹窗自己的 useEffect 都填过初值了，这时再把草稿盖上去，才不会被它们冲掉
      const 稿 = 待恢复.current;
      待恢复.current = null;
      // 动画没走完人已经动手填了：以人填的为准，不拿草稿盖
      if (开了 && 全名 && form && 稿 && !改过.current) {
        form.setFieldsValue(稿);
        改过.current = true;
        message.info({ key: "草稿恢复", content: "接着上次没填完的继续填" });
      }
      afterOpenChange?.(开了);
    },
    [全名, form, message, afterOpenChange],
  );

  const 要关 = useCallback(() => {
    if (忙 || 问着.current) return;
    const 填了 = 改过.current || Boolean(填过?.());
    if (!填了) {
      if (全名) 清草稿(全名);
      关();
      return;
    }
    问着.current = true;
    const 框 = modal.confirm({
      title: "放弃填的内容？",
      content: 全名 ? "还没保存。留着草稿的话，下次在这台电脑上打开同一个新建弹窗能接着填。" : "改的还没保存。",
      // 焦点落在「继续填」（就是 OK 那颗）：顺手按回车不会把填的扔掉
      okText: "继续填",
      focusable: { autoFocusButton: "ok" },
      // 盖在所有录入弹窗上面（就地建渠道那个小框是 1100）
      zIndex: 1200,
      afterClose: () => {
        问着.current = false;
      },
      footer: (_, { OkBtn }) => (
        <Space style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
          <Button
            danger
            onClick={() => {
              if (全名) 清草稿(全名);
              改过.current = false;
              框.destroy();
              关();
            }}
          >
            放弃
          </Button>
          {全名 && (
            <Button
              onClick={() => {
                if (form) 存草稿(全名, 取值());
                框.destroy();
                关();
              }}
            >
              留着草稿，先关掉
            </Button>
          )}
          <OkBtn />
        </Space>
      ),
    });
  }, [忙, 填过, 全名, 关, modal, form, 取值]);

  return {
    /** 摊到 <Modal> 上：点遮罩不关；Esc / X / 取消 都走 要关 */
    弹窗: { mask: { closable: false }, onCancel: 要关, afterOpenChange: 开好了 },
    /** 接到 <Form onValuesChange> 上（已有的 onValuesChange 里也调一下） */
    改了,
    存好了,
    要关,
  };
}
