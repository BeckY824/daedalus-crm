"use client";

/**
 * 扫名片（手机伴侣，2026-10-19 客户反馈：「扫名片，直接录入客户」；方案 05-反馈与复盘/名片识别-展会模式-方案-20261019.md）。
 *
 * 入口：「客户」页右上相机图标（一步到相机）、新建客户表单顶上「拍名片自动填」/「从相册选」、存完后「再扫一张」。
 * 相机没打开（没权限、被静默拒绝，2026-10-20 客户反馈「点了没反应」）：给一句话和「从相册选」，见 lib/card-scan/camera.ts。
 * 照片只在这台手机的内存里：认完只留文字；表单开着时留着这一张，给「名片语言」换语言重认，关掉表单就没了。不上传、不同步。
 */
import { useEffect, useRef, useState } from "react";
import { CameraOutlined, CloseOutlined, LoadingOutlined, PictureOutlined } from "@ant-design/icons";
import { 取照片 } from "@/lib/card-scan/camera";
import type { 名片语言, 识别结果 } from "@/lib/card-scan/ocr";
import { 名片转表单, type 名片填法 } from "@/lib/card-scan/form";

/** 先把识别引擎载起来：拍照那几秒正好下完 */
const 预热 = () => { void import("@/lib/card-scan/ocr").then((m) => m.预热()); };

/**
 * 拍名片 / 从相册选：拿到照片给 onPhoto。相机没打开（没权限、被静默拒绝）时 没开 = true，
 * 页面上给一句话和「从相册选」（NoCameraTip）；照片后来还是拍回来了，提示自己收起
 */
export function usePickPhoto(onPhoto: (f: File) => void) {
  const [没开, set没开] = useState(false);
  const 回调 = useRef(onPhoto);
  useEffect(() => { 回调.current = onPhoto; });
  const 取 = (相机: boolean) => {
    预热();
    set没开(false);
    void 取照片(相机, () => set没开(true)).then((f) => { if (f) { set没开(false); 回调.current(f); } });
  };
  return { 没开, 拍: () => 取(true), 相册: () => 取(false), 关: () => set没开(false) };
}

/** 相机没打开时的那一条：怎么开权限 + 「从相册选」（表单里紧挨着就有「从相册选」，不再放一个） */
export function NoCameraTip({ on相册, on关 }: { on相册?: () => void; on关?: () => void }) {
  const 话 = <span>相机没打开：到系统设置里给浏览器（或微信）打开相机权限；也可以先用手机相机拍好，再点「从相册选」</span>;
  const 关 = on关 && <button type="button" className="m-icon-btn" onClick={on关} aria-label="关掉"><CloseOutlined /></button>;
  // 没有自己的「从相册选」：× 跟在话后面同一行
  if (!on相册) return <div className="m-scan-nocam is-row" role="alert" data-testid="m-scan-nocam">{话}{关}</div>;
  return (
    <div className="m-scan-nocam" role="alert" data-testid="m-scan-nocam">
      {话}
      <div className="m-scan-nocam-act">
        <button type="button" className="m-scan-take" data-testid="m-scan-album" onClick={on相册}><PictureOutlined /> 从相册选</button>
        {关}
      </div>
    </div>
  );
}

/** 相机图标（客户页右上，「+」旁边）；相机没开的提示由客户页放在搜索框上面 */
export function ScanButton({ onClick }: { onClick: () => void }) {
  return (
    <button className="m-icon-btn m-add" aria-label="扫名片" data-testid="m-scan-card" onClick={onClick}>
      <CameraOutlined />
    </button>
  );
}

export type 扫的状态 =
  | { 阶段: "认"; 话: string }
  | { 阶段: "好"; 结果: 识别结果; 填法: 名片填法; 指定?: 名片语言 }
  | { 阶段: "错"; 话: string };

const 语言按钮: { k: 名片语言 | "auto"; 叫: string }[] = [
  { k: "auto", 叫: "自动" }, { k: "中英", 叫: "中英" }, { k: "日", 叫: "日" }, { k: "韩", 叫: "韩" },
  { k: "阿拉伯", 叫: "阿拉伯" }, { k: "泰", 叫: "泰" }, { k: "西里尔", 叫: "俄" }, { k: "天城", 叫: "印地" },
];

/**
 * 认一张：照片 → 表单填法。图留在 ref 里给换语言用，组件卸载就放掉
 */
export function useCardScan(外贸: boolean, onFilled: (填法: 名片填法) => void) {
  const [态, set态] = useState<扫的状态 | null>(null);
  const 图 = useRef<File | null>(null);
  const 次 = useRef(0);
  const 回调 = useRef(onFilled);
  useEffect(() => { 回调.current = onFilled; });
  useEffect(() => () => { 图.current = null; }, []);
  const 认 = async (f: File, 指定?: 名片语言) => {
    图.current = f;
    const 这次 = ++次.current;
    set态({ 阶段: "认", 话: "正在准备识别…" });
    try {
      const { 认名片 } = await import("@/lib/card-scan/ocr");
      const r = await 认名片(f, (话) => { if (这次 === 次.current) set态({ 阶段: "认", 话 }); }, 指定);
      if (这次 !== 次.current) return;
      const 填法 = 名片转表单(r.字段, 外贸);
      if (!r.框数 || (!填法.填.name && !填法.填.phone && !填法.填.email)) {
        set态({ 阶段: "错", 话: "没认出字。名片横着放、靠近一点、别反光，再拍一张试试" });
        return;
      }
      set态({ 阶段: "好", 结果: r, 填法, 指定 });
      回调.current(填法);
    } catch (e) {
      if (这次 !== 次.current) return;
      const 话 = e instanceof Error ? e.message : String(e);
      set态({ 阶段: "错", 话: /fetch|network|Failed to load|import/i.test(话) ? "识别模型没下载下来：连上网再试一次（下过一次之后没网也能认）" : `没认出来：${话}` });
    }
  };
  return {
    态,
    认,
    换语言: (k: 名片语言 | "auto") => { if (图.current) void 认(图.current, k === "auto" ? undefined : k); },
    清: () => { 次.current++; 图.current = null; set态(null); },
  };
}

/** 表单顶上那一条：没拍过是「拍名片自动填」+「从相册选」；认的时候转圈；认好了列「名片语言」 */
export function ScanBar({ 态, onPhoto, on换语言 }: { 态: 扫的状态 | null; onPhoto: (f: File) => void; on换语言: (k: 名片语言 | "auto") => void }) {
  const 取 = usePickPhoto(onPhoto);
  if (态?.阶段 === "认") {
    return <div className="m-scan-bar is-busy" data-testid="m-scan-busy" role="status"><LoadingOutlined /><span>{态.话}</span></div>;
  }
  const 拍 = (
    <span className="m-scan-btns">
      <button type="button" className="m-scan-take" data-testid="m-scan-fill" onClick={取.拍}>
        <CameraOutlined /> {态 ? "重拍" : "拍名片自动填"}
      </button>
      <button type="button" className="m-scan-take is-ghost" data-testid="m-scan-fill-album" onClick={取.相册}>
        <PictureOutlined /> 从相册选
      </button>
    </span>
  );
  const 没开 = 取.没开 && <NoCameraTip on关={取.关} />;
  if (!态) return <>{没开}<div className="m-scan-bar">{拍}<span className="m-scan-hint">认完只留文字，照片不保存</span></div></>;
  if (态.阶段 === "错") return <>{没开}<div className="m-scan-bar is-err" role="alert"><span>{态.话}</span>{拍}</div></>;
  const 当前 = 态.指定 ?? "auto";
  return (
    <>
      {没开}
      <div className="m-scan-bar is-done" data-testid="m-scan-done">
        <div className="m-scan-row"><span>已按名片填好，<b className="m-scan-mark">标黄</b>的请看一眼</span>{拍}</div>
        <div className="m-scan-langs" aria-label="名片语言">
          <span>名片语言</span>
          {语言按钮.map((x) => (
            <button type="button" key={x.k} className={当前 === x.k ? "is-on" : ""} onClick={() => on换语言(x.k)}>
              {x.k === "auto" && 当前 === "auto" && 态.结果.语言 !== "中英" ? `自动·${语言按钮.find((y) => y.k === 态.结果.语言)?.叫}` : x.叫}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
