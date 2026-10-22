"use client";

import { useCallback, useEffect, useState } from "react";
import { App, Button, Image, Popconfirm, Spin, Upload } from "antd";
import { DeleteOutlined, FileOutlined, InboxOutlined } from "@ant-design/icons";
import { 附件上限字节, 图片长边, 可以压, 要重画, 是图片, 换成jpg, 每条最多, 规整文件名, 超限说明, 读大小, 只收图片, 收的类型, 不收说明, type 附件, type 归属 } from "@/lib/attachment-rules";

declare global {
  interface Window {
    /** 桌面端 preload-app.js：拷到临时目录用系统程序打开 */
    desktopAttachments?: { open(id: string, 名: string): Promise<{ ok: boolean; 只显示?: boolean; error?: string }> };
  }
}

/**
 * 商机 / 订单上的「图片」区（2026-10-22 D-24）：拖进来或点选；出缩略图、点开看大图；能删。
 * 图片先在这台电脑上压到长边 2000 像素再传，超了上限当场说超了多少，不等传完。
 * 这一版只收图片（只收图片）；别的文件那套（写名字大小、点开交给系统程序）留着，放开时不用重写
 */
export default function AttachmentsPanel({ 归属: 挂在 }: { 归属: 归属 }) {
  const { message } = App.useApp();
  const [列表, set列表] = useState<附件[] | null>(null);
  const [传着, set传着] = useState(0);
  const 查询 = "opportunityId" in 挂在 ? `opportunityId=${encodeURIComponent(挂在.opportunityId)}` : `orderId=${encodeURIComponent(挂在.orderId)}`;

  const 读 = useCallback(async (): Promise<附件[]> => {
    const r = await fetch(`/api/attachments?${查询}`, { cache: "no-store" });
    const j = (await r.json().catch(() => ({}))) as { 附件?: 附件[]; error?: string };
    if (!r.ok) throw new Error(j.error ?? `读图片没成（${r.status}）`);
    return j.附件 ?? [];
  }, [查询]);

  const 刷新 = useCallback(
    () =>
      读().then(set列表, (e: unknown) => {
        set列表((x) => x ?? []);
        message.error(e instanceof Error ? e.message : "读图片没成");
      }),
    [读, message],
  );

  useEffect(() => {
    let 走了 = false;
    读().then(
      (x) => { if (!走了) set列表(x); },
      (e: unknown) => {
        if (走了) return;
        set列表([]);
        message.error(e instanceof Error ? e.message : "读图片没成");
      },
    );
    return () => { 走了 = true; };
  }, [读, message]);

  async function 传一个(f: File) {
    const 名 = 规整文件名(f.name);
    const 不收 = 不收说明(名, f.type);
    if (不收) return void message.error(不收);
    set传着((n) => n + 1);
    try {
      const 好 = await 准备(f, 名);
      const 超 = 超限说明(好.名, 好.体.size);
      if (超) return void message.error(超);
      const q = new URLSearchParams({ name: 好.名 });
      if (好.w && 好.h) { q.set("w", String(好.w)); q.set("h", String(好.h)); }
      const r = await fetch(`/api/attachments?${查询}&${q}`, {
        method: "POST",
        body: 好.体,
        headers: { "Content-Type": 好.体.type || "application/octet-stream" },
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) return void message.error(j.error ?? `「${名}」没传上去（${r.status}）`);
      await 刷新();
    } catch (e) {
      message.error(`「${名}」没传上去：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      set传着((n) => n - 1);
    }
  }

  async function 删(a: 附件) {
    const r = await fetch(`/api/attachments/${a.id}`, { method: "DELETE" });
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    if (!r.ok) return void message.error(j.error ?? "没删掉");
    set列表((x) => x?.filter((y) => y.id !== a.id) ?? null);
  }

  async function 打开(a: 附件) {
    if (!a.有文件) {
      // 团队版：别人刚传的可能还在路上，问一句服务器那边到了没有
      const r = await fetch(`/api/attachments/${a.id}`, { method: "HEAD" }).catch(() => null);
      if (r?.status === 409) return void message.info("对方还在上传，稍后再看");
      if (!r?.ok) return void message.warning("文件不在这台电脑上");
      await 刷新();
    }
    const 桥 = typeof window !== "undefined" ? window.desktopAttachments : undefined;
    if (桥) {
      const r = await 桥.open(a.id, a.name);
      if (!r.ok) message.error(r.error ?? "没打开");
      else if (r.只显示) message.info("这类文件不直接运行，已在文件夹里选中它");
      return;
    }
    // 网页 / 连着服务器：当下载
    const 链 = document.createElement("a");
    链.href = `/api/attachments/${a.id}`;
    链.download = a.name;
    链.click();
  }

  const 图们 = (列表 ?? []).filter((a) => 是图片(a.mime));
  const 别的 = (列表 ?? []).filter((a) => !是图片(a.mime));
  const 满了 = (列表?.length ?? 0) >= 每条最多;

  return (
    <div className="att-panel">
      <Upload.Dragger
        multiple
        showUploadList={false}
        disabled={满了}
        accept={只收图片 ? 收的类型 : undefined}
        beforeUpload={(f) => {
          void 传一个(f);
          return false;
        }}
      >
        <p className="ant-upload-drag-icon"><InboxOutlined /></p>
        <p className="ant-upload-text">{满了 ? `已经 ${每条最多} 张了，先删掉几张不要的` : 只收图片 ? "把产品图片拖到这里，或点一下选图片" : "把文件拖到这里，或点一下选文件"}</p>
        <p className="ant-upload-hint">JPG、PNG、GIF、WebP、BMP 都行；单张最多 {读大小(附件上限字节)}，会先压到长边 {图片长边} 像素再存</p>
      </Upload.Dragger>

      {列表 === null ? (
        <div style={{ padding: 16, textAlign: "center" }}><Spin /></div>
      ) : (
        <>
          {传着 > 0 && <div className="muted" style={{ marginTop: 10 }}><Spin size="small" /> 正在传 {传着} 个…</div>}
          {列表.length === 0 && 传着 === 0 && <div className="muted" style={{ marginTop: 10 }}>{只收图片 ? "还没有图片。" : "还没有附件。"}</div>}
          {图们.length > 0 && (
            <Image.PreviewGroup>
              <div className="att-pics">
                {图们.map((a) => (
                  <div key={a.id} className="att-pic" title={`${a.name} · ${读大小(a.size)}`}>
                    {a.有文件 ? (
                      <Image src={`/api/attachments/${a.id}`} alt={a.name} width={96} height={96} style={{ objectFit: "cover" }} />
                    ) : (
                      <div className="att-missing">文件不在这台电脑上</div>
                    )}
                    <div className="att-pic-name">{a.name}</div>
                    <删按钮 a={a} 删={删} />
                  </div>
                ))}
              </div>
            </Image.PreviewGroup>
          )}
          {别的.length > 0 && (
            <ul className="att-files">
              {别的.map((a) => (
                <li key={a.id}>
                  <FileOutlined />
                  <a onClick={() => void 打开(a)} title="用这台电脑上的程序打开">{a.name}</a>
                  <span className="muted">{a.有文件 ? 读大小(a.size) : "文件不在这台电脑上"}</span>
                  <删按钮 a={a} 删={删} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

function 删按钮({ a, 删 }: { a: 附件; 删: (a: 附件) => Promise<void> }) {
  return (
    <Popconfirm title={`删掉「${a.name}」？`} okText="删掉" okButtonProps={{ danger: true }} cancelText="不删" onConfirm={() => 删(a)}>
      <Button size="small" type="text" danger icon={<DeleteOutlined />} aria-label={`删掉 ${a.name}`} />
    </Popconfirm>
  );
}

/**
 * 能压的图片长边超过 图片长边 就在这台电脑上缩：JPEG / WebP / BMP 出 JPEG（白底，0.85），PNG 还是 PNG（可能是带透明的图标）。
 * JPEG / WebP / BMP 不超也重画一遍，去掉 EXIF（拍摄地点、相机型号）；按 EXIF 里的方向先转正，竖拍的不会躺倒。
 * GIF、别的文件原样；读不出来的图也原样传
 */
async function 准备(f: File, 名: string): Promise<{ 体: Blob; 名: string; w?: number; h?: number }> {
  if (!可以压(f.type) || typeof createImageBitmap !== "function") return { 体: f, 名 };
  let 图: ImageBitmap;
  try { 图 = await createImageBitmap(f, { imageOrientation: "from-image" }); } catch { return { 体: f, 名 }; }
  try {
    if (!要重画(f.type, 图.width, 图.height)) return { 体: f, 名, w: 图.width, h: 图.height };
    const 比 = Math.min(1, 图片长边 / Math.max(图.width, 图.height));
    const w = Math.round(图.width * 比);
    const h = Math.round(图.height * 比);
    const 画布 = document.createElement("canvas");
    画布.width = w;
    画布.height = h;
    const g = 画布.getContext("2d");
    if (!g) return { 体: f, 名, w: 图.width, h: 图.height };
    const png = f.type === "image/png";
    // JPEG 没有透明，透明处垫白（和界面主题无关，所以不走 token）
    if (!png) { g.fillStyle = "white"; g.fillRect(0, 0, w, h); }
    g.imageSmoothingQuality = "high";
    g.drawImage(图, 0, 0, w, h);
    const 体 = await new Promise<Blob | null>((ok) => 画布.toBlob(ok, png ? "image/png" : "image/jpeg", 0.85));
    if (!体) return { 体: f, 名, w: 图.width, h: 图.height };
    return { 体, 名: png || f.type === "image/jpeg" ? 名 : 换成jpg(名), w, h };
  } finally {
    图.close();
  }
}
