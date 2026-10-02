"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { App, Button, Tooltip } from "antd";
import { StarFilled, StarOutlined } from "@ant-design/icons";
import { 切换收藏 } from "../../favorites";

/**
 * 记录页名字旁边的星：点了这位就进左栏「收藏的客户」，再点就拿掉。
 * 先改星的样子再等回话（人点完要立刻看到变了）；失败了退回去并说一句。
 */
export default function StarButton({ customerId, 初值 }: { customerId: string; 初值: boolean }) {
  const router = useRouter();
  const { message } = App.useApp();
  const [收藏了, set收藏了] = useState(初值);
  const [pending, start] = useTransition();
  const 名 = 收藏了 ? "从左栏收藏里拿掉" : "收藏到左栏";
  return (
    <Tooltip title={名}>
      <Button
        type="text"
        size="small"
        className={`rec-star${收藏了 ? " on" : ""}`}
        aria-label={名}
        aria-pressed={收藏了}
        disabled={pending}
        icon={收藏了 ? <StarFilled /> : <StarOutlined />}
        onClick={() => {
          const 想要 = !收藏了;
          set收藏了(想要);
          start(async () => {
            const r = await 切换收藏(customerId);
            if (!r.ok) {
              set收藏了(!想要);
              message.error(r.error);
              return;
            }
            set收藏了(r.收藏了);
            router.refresh();
          });
        }}
      />
    </Tooltip>
  );
}
