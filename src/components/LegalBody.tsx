"use client";

import { useCallback, useEffect, useState } from "react";

type 节 = { id: string; 标题: string };

/**
 * 条款页的「左目录 + 正文」两栏。**目录从正文现扫出来，不手写一份章节表**——
 * 两份条款各八九节，手维护的表改了正文忘了改表，就会指到一个不存在的锚点去。
 *
 * 扫的时机是正文那个 <article> 的 ref 回调，不是 useEffect：
 * 在 effect 体里直接 setState 会连着触发一轮渲染（eslint 的 react-hooks/set-state-in-effect
 * 拦的就是这个）。ref 回调在挂载时拿到真元素，正是扫 DOM 的地方。
 * 正文是服务端渲染好的静态内容，扫一次就够，不用监听后续变化。
 *
 * 当前节靠 IntersectionObserver 跟着滚动走：法律长文最容易丢的就是
 * 「我现在读到哪一节了」。observer 不支持时（很老的内核）目录照常可点，
 * 只是不高亮——一个不高亮的目录仍然有用，一个报错的页面没有。
 */
export default function LegalBody({ children }: { children: React.ReactNode }) {
  const [节们, set节们] = useState<节[]>([]);
  const [当前, set当前] = useState("");

  const 扫目录 = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    const hs = Array.from(el.querySelectorAll("h2"));
    hs.forEach((h, i) => {
      if (!h.id) h.id = `sec-${i + 1}`;
    });
    set节们(hs.map((h) => ({ id: h.id, 标题: h.textContent?.trim() ?? "" })));
    set当前(hs[0]?.id ?? "");
  }, []);

  useEffect(() => {
    if (节们.length === 0 || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (es) => {
        const 露出来的 = es
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (露出来的) set当前(露出来的.target.id);
      },
      // 上边留 96px：标题刚滑到页顶下面一点就算「正在读这一节」
      { rootMargin: "-96px 0px -70% 0px" },
    );
    for (const s of 节们) {
      const el = document.getElementById(s.id);
      if (el) io.observe(el);
    }
    return () => io.disconnect();
  }, [节们]);

  return (
    <div className="legal-cols">
      <nav className="legal-toc" aria-label="章节目录">
        {节们.map((s) => (
          <a key={s.id} href={`#${s.id}`} className={当前 === s.id ? "on" : undefined}>
            {s.标题}
          </a>
        ))}
      </nav>
      <article className="legal-body" ref={扫目录}>
        {children}
      </article>
    </div>
  );
}
