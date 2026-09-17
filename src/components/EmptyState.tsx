"use client";

import { useEffect, useState, useTransition } from "react";
import { App, Button, Modal } from "antd";
import Rise from "./Rise";
import SlideConfirm from "./SlideConfirm";
import { PlusOutlined, ExperimentOutlined } from "@ant-design/icons";
import { useRouter } from "next/navigation";
import { 查演示数据状态, 灌一套演示数据, 清除演示数据, type 演示数据状态 } from "@/app/(app)/demo-data";

/**
 * 空状态。
 *
 * 原来每个空列表都是 antd 默认的「暂无数据」盒子——它说的是「没有」，
 * 而第一次打开的人需要知道的是「接下来做什么」。所以每个空状态说三件事：
 * 这是什么、第一步（一个主按钮）、还有什么别的路（导入 / 演示数据）。
 *
 * 演示数据那个按钮由这里自己判断要不要出现（托管版不给、非管理员不给、库非空不给），
 * 调用方不用管——它在每个空状态上都该是同一套规则。
 */
export default function EmptyState({
  title,
  hint,
  primary,
  secondary,
  /** 这一页的空状态要不要带「灌一套演示数据」。列表页都带，子页面（比如管道）不带 */
  demo = true,
}: {
  title: string;
  hint: string;
  primary?: { label: string; onClick: () => void };
  secondary?: { label: string; onClick: () => void }[];
  demo?: boolean;
}) {
  return (
    /* 和 StatePage 同一张脸、同一个进场：空、404、出错在人眼里是一件事 */
    <Rise className="empty-state">
      <div className="empty-state-t">{title}</div>
      <p className="empty-state-h">{hint}</p>
      <div className="empty-state-a">
        {primary && (
          <Button type="primary" icon={<PlusOutlined />} onClick={primary.onClick}>
            {primary.label}
          </Button>
        )}
        {secondary?.map((s) => (
          <Button key={s.label} onClick={s.onClick}>
            {s.label}
          </Button>
        ))}
        {demo && <DemoDataButton />}
      </div>
    </Rise>
  );
}

/**
 * 「灌一套演示数据」/「清除演示数据」。
 *
 * 状态问服务端要（部署形态、角色、库空不空），条件不满足就什么都不画——
 * 这几条判断只能在服务端做，客户端拿不到 MULTI_TENANT，也不该信客户端说自己是管理员。
 */
export function DemoDataButton() {
  const [状态, set状态] = useState<演示数据状态 | null>(null);
  /** 清除前那一问。它自己是个 Modal，因为要在框里放滑动确认 */
  const [问, set问] = useState(false);
  const [pending, startTransition] = useTransition();
  const { message } = App.useApp();
  const router = useRouter();

  useEffect(() => {
    查演示数据状态().then(set状态).catch(() => {});
  }, []);

  if (!状态?.可用 || !状态.有权限) return null;

  if (状态.已灌) {
    return (
      <>
        <Button danger loading={pending} onClick={() => set问(true)}>
          清除演示数据
        </Button>
        {/*
          **全站唯一一处滑动确认**（components/SlideConfirm.tsx）。
          这一下删掉的是库里全部业务数据，而「确定」那颗键和「保存」长得一模一样——
          手比脑子快的时候它挡不住任何人。解释仍然要写：闸门防的是误触，说清楚防的是误解。
        */}
        <Modal open={问} onCancel={() => set问(false)} title="清除演示数据？" footer={null} width={460}>
          <p style={{ marginTop: 0, color: "var(--ink-soft)", lineHeight: 1.7 }}>
            会删掉这个库里<b>全部</b>业务数据：学员、线索、渠道、商机、跟进、待办、操作日志。
            灌完演示数据之后你自己录的也一起没。设置和账号不动。
          </p>
          <SlideConfirm
            话="滑到右边清除"
            忙={pending}
            做={() =>
              new Promise<void>((resolve) =>
                startTransition(async () => {
                  const r = await 清除演示数据();
                  if (r.ok) {
                    message.success("演示数据已清除");
                    set状态({ ...状态, 空库: true, 已灌: false });
                    set问(false);
                    router.refresh();
                  } else message.error(r.error);
                  resolve();
                }),
              )
            }
          />
        </Modal>
      </>
    );
  }

  if (!状态.空库) return null;
  return (
    <Button
      icon={<ExperimentOutlined />}
      loading={pending}
      onClick={() =>
        startTransition(async () => {
          const r = await 灌一套演示数据();
          if (r.ok) {
            message.success("演示数据已灌入，可以随便点");
            set状态({ ...状态, 空库: false, 已灌: true });
            router.refresh();
          } else message.error(r.error);
        })
      }
    >
      灌一套演示数据看看
    </Button>
  );
}

/** antd Table 的 locale.emptyText 要的是一个节点，包一层免得每个调用处都写 */
export function 表格空态(props: Parameters<typeof EmptyState>[0]) {
  return { emptyText: <EmptyState {...props} /> };
}
