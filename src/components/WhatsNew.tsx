"use client";
/**
 * 桌面端「这一版更新了什么」（2026-10-02）。
 *
 * **更新之后第一次打开，自己弹一次**（2026-10-04 用户：「更新 notes 是在更新之后告诉用户更新了什么，
 * 类似于一个弹窗页面，里面具体写下结构化的更新」——推翻 10-02「不在启动时自己弹」）。
 * 弹窗按 CHANGELOG 的节排成一张张卡（标题 + 要点），顶上一排节标题点了跳过去；关掉就算看过，下次不再弹。
 * 新装的不弹（没有「更新了什么」可言）；不进 Dock 数、不发系统通知。
 * 左栏账号那一行的「新」留着：弹窗没来得及关就退出了，下次还会弹，那枚也还在。
 * 账号菜单里的「更新记录」打开同一个框，翻最近几十版（全部模式），那边关掉不改「看过」。
 *
 * 只在桌面端渲染（AppShell 里 desktop 才挂）；服务端那边也只在本地模式下回内容。
 */
import { useEffect, useRef, useState } from "react";
import { Button, Modal } from "antd";
import Markdown from "@/components/Markdown";
import { 有没有新内容, 看过了, 全部更新记录 } from "@/app/(app)/whats-new-actions";
import { 分节, type 一版 } from "@/lib/changelog";

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

/** 刚更新完弹出来的那一页：一版一页，一节一张卡，顶上节标题当目录 */
function 这一版({ 段 }: { 段: 一版[] }) {
  return (
    <div className="wn-page">
      {段.map((s) => {
        const 节们 = 分节(s.正文);
        const 有标题的 = 节们.filter((x) => x.标题);
        return (
          <section key={s.版本} className="wn-pver">
            {段.length > 1 && (
              <h3 className="wn-pver-h">
                {s.版本}
                {s.日期 && <span>{说日期(s.日期)}</span>}
              </h3>
            )}
            {有标题的.length > 3 && (
              <nav className="wn-toc" aria-label={`${s.版本} 这一版的几项`}>
                {有标题的.map((x, i) => (
                  <button
                    key={x.标题}
                    type="button"
                    onClick={() => document.getElementById(`wn-${s.版本}-${i}`)?.scrollIntoView({ behavior: "smooth", block: "start" })}
                  >
                    {x.标题}
                  </button>
                ))}
              </nav>
            )}
            <div className="wn-cards">
              {节们.map((x) => {
                const i = 有标题的.indexOf(x);
                return (
                  <article key={`${x.标题}-${x.正文.slice(0, 12)}`} id={i >= 0 ? `wn-${s.版本}-${i}` : undefined} className="wn-card">
                    {x.标题 && <h4>{x.标题}</h4>}
                    <Markdown text={x.正文} />
                  </article>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export default function WhatsNew({ 全部开着, 关全部 }: { 全部开着: boolean; 关全部: () => void }) {
  const [新, set新] = useState<{ 版本: string; 段: 一版[] } | null>(null);
  const [开, set开] = useState(false);
  const [全部, set全部] = useState<{ 现在: string; 段: 一版[] } | null>(null);
  const [全部出错, set全部出错] = useState(false);
  const 知道了键 = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    有没有新内容()
      .then((x) => {
        set新(x);
        // 刚更新完：自己弹一次（关掉才算看过）
        if (x) set开(true);
      })
      .catch(() => {});
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
        /*
          打开时从头看起、焦点落在「知道了」：默认焦点落在第一个能聚焦的东西上（目录里某个节标题或右上角的叉），
          滚动条跟着它跑到中间，顶上那排目录反而看不见（2026-10-04 实机）。回车就能关
        */
        afterOpenChange={(开了) => {
          if (!开了) return;
          document.querySelector(".wn-modal .ant-modal-body")?.scrollTo({ top: 0 });
          知道了键.current?.focus({ preventScroll: true });
        }}
        title={
          新 ? (
            <div className="wn-title">
              <span>已更新到 {新.版本}，这一版更新了这些</span>
              {新.段[0]?.日期 && <small>{说日期(新.段[0].日期)}</small>}
            </div>
          ) : ""
        }
        width={760}
        className="wn-modal"
        footer={
          <Button ref={知道了键} type="primary" onClick={收起}>
            知道了
          </Button>
        }
      >
        {新 && <这一版 段={新.段} />}
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
