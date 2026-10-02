"use client";
/**
 * 桌面端「这一版更新了什么」（2026-10-02）。
 *
 * 更新之后，左栏账号那一行右端多一枚「新」（和更新键、反馈键同一排）；点开看这次新的那几段，
 * 关掉就算看过、那枚收起来。**不在启动时自己弹**：人打开应用是来干活的，不是来读更新说明的；
 * 也不进 Dock 数、不发系统通知——这不是一件要你去处理的事。
 * 账号菜单里的「更新记录」打开同一个框，翻最近几十版（全部模式），那边关掉不改「看过」。
 *
 * 只在桌面端渲染（AppShell 里 desktop 才挂）；服务端那边也只在本地模式下回内容。
 */
import { useEffect, useState } from "react";
import { Button, Modal } from "antd";
import Markdown from "@/components/Markdown";
import { 有没有新内容, 看过了, 全部更新记录 } from "@/app/(app)/whats-new-actions";
import type { 一版 } from "@/lib/changelog";

/** 「2026-10-04」→「10 月 4 日」：和别处的日期说法一致，年份不重要 */
function 说日期(d: string | null): string {
  const m = d?.match(/^\d{4}-(\d{1,2})-(\d{1,2})$/);
  return m ? `${Number(m[1])} 月 ${Number(m[2])} 日` : (d ?? "");
}

function 各版({ 段 }: { 段: 一版[] }) {
  return (
    <div className="wn-list">
      {段.map((s) => (
        <section key={s.版本} className="wn-ver">
          <h3>
            {s.版本}
            {s.日期 && <span>{说日期(s.日期)}</span>}
          </h3>
          <Markdown text={s.正文} />
        </section>
      ))}
    </div>
  );
}

export default function WhatsNew({ 全部开着, 关全部 }: { 全部开着: boolean; 关全部: () => void }) {
  const [新, set新] = useState<{ 版本: string; 段: 一版[] } | null>(null);
  const [开, set开] = useState(false);
  const [全部, set全部] = useState<{ 现在: string; 段: 一版[] } | null>(null);
  const [全部出错, set全部出错] = useState(false);

  useEffect(() => {
    有没有新内容().then(set新).catch(() => {});
  }, []);

  function 读全部() {
    set全部出错(false);
    全部更新记录().then(set全部).catch(() => set全部出错(true));
  }


  function 收起() {
    set开(false);
    // 先收图标再告诉服务端：网络慢时不让那枚「新」在关掉之后还挂着
    set新(null);
    void 看过了().catch(() => {});
  }

  /** 那枚「新」随着看过一起消失了，焦点不能落回 body：交给旁边的账号键 */
  function 焦点回账号() {
    document.querySelector<HTMLButtonElement>(".rail-user")?.focus();
  }

  return (
    <>
      {新 && (
        <button
          type="button"
          className="rail-new"
          onClick={() => set开(true)}
          aria-label={`已更新到 ${新.版本}，看看这一版改了什么`}
          title={`已更新到 ${新.版本}，看看这一版改了什么`}
        >
          新
        </button>
      )}

      <Modal
        open={开 && !!新}
        onCancel={收起}
        afterClose={焦点回账号}
        title={新 ? `已更新到 ${新.版本}` : ""}
        width={560}
        footer={
          <Button type="primary" onClick={收起}>
            知道了
          </Button>
        }
      >
        {新 && <各版 段={新.段} />}
      </Modal>

      <Modal
        open={全部开着}
        onCancel={关全部}
        // 第一次打开才去读；读过就留着，关了再开不再转一圈
        afterOpenChange={(开了) => {
          if (开了 && !全部) 读全部();
        }}
        title={全部 ? `更新记录 · 现在是 ${全部.现在}` : "更新记录"}
        width={560}
        footer={null}
      >
        {全部出错 ? (
          <p className="wn-empty">
            读不出更新记录。{" "}
            <Button type="link" size="small" onClick={读全部}>
              重试
            </Button>
          </p>
        ) : !全部 ? (
          <p className="wn-empty">正在读…</p>
        ) : 全部.段.length ? (
          <各版 段={全部.段} />
        ) : (
          <p className="wn-empty">这一版没有带更新记录。</p>
        )}
      </Modal>
    </>
  );
}
