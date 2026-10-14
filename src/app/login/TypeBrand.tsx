"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useReducedMotion } from "motion/react";
import { 打字 } from "@/lib/motion";

const 名字 = "Daedalus.AI CRM";
let 看过=false;
const 不订阅=()=>()=>{};
function 读看过(){try{return 看过||sessionStorage.getItem("crm:auth-brand-seen")==="1"}catch{return 看过}}
function 记看过(){看过=true;try{sessionStorage.setItem("crm:auth-brand-seen","1")}catch{/* 本次会话用内存 */}}
const 服务端未看=()=>false;

/**
 * 登录页像素标旁边的名字：打字机一样一个字一个字打出来，方块光标跟着往前走，打完闪几下收掉。
 *
 * 没打到的字也占着位置（visibility: hidden），只是看不见——打的过程中整行宽度不变，
 * 标和名字不会跟着一点点往右挤。开了「减弱动态」就直接是打好的样子，没有光标。
 */
export default function TypeBrand() {
  const 少动 = Boolean(useReducedMotion());
  const 已看=useSyncExternalStore(不订阅,读看过,服务端未看);
  const [n, setN] = useState(0);
  const [收了, set收了] = useState(false);

  useEffect(() => {
    if (少动) {记看过();return;}
    if (已看) return;
    let 定时: ReturnType<typeof setInterval> | undefined;
    const 起 = setTimeout(() => {
      定时 = setInterval(() => {
        setN((k) => {
          if (k + 1 >= 名字.length) clearInterval(定时);
          return Math.min(k + 1, 名字.length);
        });
      }, 打字.每字 * 1000);
    }, 打字.起步 * 1000);
    return () => {
      clearTimeout(起);
      clearInterval(定时);
      记看过();
    };
  }, [少动,已看]);

  const 打完 = 少动 || 已看 || n >= 名字.length;
  useEffect(() => {
    if (!打完 || 少动 || 已看) return;
    记看过();
    const t = setTimeout(() => set收了(true), 打字.收尾 * 1000);
    return () => clearTimeout(t);
  }, [打完, 少动,已看]);

  const 显示 = 少动 || 已看 ? 名字.length : n;
  return (
    <span className="auth-brand" aria-label={名字}>
      {[...名字].map((c, k) => (
        <span key={k} aria-hidden="true" className={k < 显示 ? undefined : "auth-brand-todo"} data-ai={k >= 8 && k <= 10 ? "" : undefined}>
          {c === " " ? " " : c}
          {/* 光标贴在刚打出来的那个字后面；一个字都没打时贴在最前面 */}
          {!少动 && !已看 && !收了 && k === Math.max(显示 - 1, 0) && <i className={`auth-brand-caret${显示 === 0 ? " at-start" : ""}`} />}
        </span>
      ))}
    </span>
  );
}
