"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Table, Button, Dropdown, Checkbox } from "antd";
import { SettingOutlined } from "@ant-design/icons";
import type { ColumnType } from "antd/es/table";
import EmptyState from "@/components/EmptyState";
import { useLocalPref } from "@/lib/local-pref";

/**
 * 列表页的那张表。**全站只有这一个表格实现**（批 2 抽出来，批 3 六页照用）。
 *
 * 每个列表页自己要写的只剩四样：列、筛选、空状态的第一步、主动作。
 * 密度、选中态、分页、列设置、批量工具条、空库时收起筛选栏——都在这里，改一处全站都改。
 *
 * 几条不显然但踩过的：
 *   - 「空库」是「一条都没有**且**没在筛」。筛出 0 条不算——那时筛选栏必须留着，
 *     否则人看不见自己筛了什么，也点不到重置
 *   - 主动作永远在原位。空状态里那个「新建第一位」是给第一次进来的人的引导，
 *     不是它的替代品；老用户会去工具栏找它
 *   - 列设置存在本地，一页一份。每个人常看的列不一样，不该逼所有人用同一套；
 *     后来新增的列按它自己的默认值补进去，不然加了列的人永远看不到
 */
export type 列<T> = ColumnType<T> & {
  /** 列设置里显示的名字。title 不是纯文字（带图标之类）时必须给 */
  列名?: string;
  /** false = 默认收在「列」里，要勾才显示。不写就是默认显示 */
  默认?: boolean;
  /** true = 不进列设置，永远跟着（操作列） */
  常驻?: boolean;
};

type Props<T> = {
  /** 记列设置用的键，一页一个，比如 "customers" */
  页: string;
  列: 列<T>[];
  行: T[];
  /** 一条都没有**且**没在筛 */
  空库: boolean;
  空态: Parameters<typeof EmptyState>[0];
  /** 主动作与常驻按钮，永远在 */
  动作?: React.ReactNode;
  /** 筛选栏。空库时整条不渲染 */
  筛选?: React.ReactNode;
  /** 勾了行之后才出现的工具条。不给就不支持多选 */
  批量?: (选中: string[], 清空: () => void) => React.ReactNode;
  加载中?: boolean;
  /** 点一行去哪。给了就整行可点；点在按钮、链接、勾选框上不算 */
  行链接?: (r: T) => string;
  横向?: number;
  分页?: { 当前页: number; 每页: number; 总数: number; 翻页: (页: number, 每页: number) => void };
};

const 列键 = <T,>(c: 列<T>) => String(c.key ?? c.dataIndex);

export default function DataList<T extends { id: string }>({
  页, 列: 全部列, 行, 空库, 空态, 动作, 筛选, 批量, 加载中, 行链接, 横向, 分页,
}: Props<T>) {
  const router = useRouter();
  const [选中, set选中] = useState<string[]>([]);

  const 可选的 = useMemo(() => 全部列.filter((c) => !c.常驻), [全部列]);
  const 默认可见 = useMemo(() => 可选的.filter((c) => c.默认 !== false).map(列键), [可选的]);
  /** 列设置存在这台机器上，一页一份。丢了就回到默认那套，不影响用 */
  const [存的, 存列] = useLocalPref<string[] | null>(`list-cols:${页}`, null);

  const 可见 = useMemo(() => {
    if (!存的) return 默认可见;
    // 存完之后新加的列：存的时候还不存在，按它自己的默认值补上，
    // 不然加了列的人永远看不到新列
    const 存过的 = new Set(存的);
    return [...存的, ...可选的.filter((c) => !存过的.has(列键(c)) && c.默认 !== false).map(列键)];
  }, [存的, 默认可见, 可选的]);

  function 切列(k: string, 显示: boolean) {
    存列(显示 ? [...可见, k] : 可见.filter((x) => x !== k));
  }

  const 显示的列 = useMemo(
    () => 全部列.filter((c) => c.常驻 || 可见.includes(列键(c))),
    [全部列, 可见],
  );

  /**
   * 表格自己的最小宽度。不给就按显示中的列宽加起来算。
   * 必须有一个值：没有它，列一多就把**整页**撑出横向滚动条；
   * 有了它，超出的部分在表格自己的框里横滚，页面不动。
   */
  const x = 横向 ?? 显示的列.reduce((s2, c) => s2 + (typeof c.width === "number" ? c.width : 120), 0);

  return (
    <div className="list">
      {!空库 && 筛选}

      <div className="list-bar">
        {动作}
        <span className="list-bar-gap" />
        {!空库 && 可选的.length > 0 && (
          <Dropdown
            trigger={["click"]}
            menu={{
              items: 可选的.map((c) => {
                const k = 列键(c);
                return {
                  key: k,
                  label: (
                    <Checkbox checked={可见.includes(k)} onChange={(e) => 切列(k, e.target.checked)}>
                      {c.列名 ?? String(c.title)}
                    </Checkbox>
                  ),
                };
              }),
            }}
          >
            <Button icon={<SettingOutlined />}>列</Button>
          </Dropdown>
        )}
      </div>

      {/* 批量工具条：勾了才出现，而且要说清「已选 N 条」——不说人对不上自己勾了几条 */}
      {批量 && 选中.length > 0 && (
        <div className="list-sel">
          <b>已选 {选中.length} 条</b>
          {批量(选中, () => set选中([]))}
          <button type="button" className="list-sel-x" onClick={() => set选中([])}>
            取消选择
          </button>
        </div>
      )}

      <Table<T>
        rowKey="id"
        size="middle"
        dataSource={行}
        columns={显示的列}
        loading={加载中}
        locale={{ emptyText: <EmptyState {...空态} /> }}
        scroll={{ x }}
        rowSelection={批量 ? { selectedRowKeys: 选中, onChange: (k) => set选中(k as string[]) } : undefined}
        onRow={
          行链接
            ? (r) => ({
                onClick: (e) => {
                  // 点在按钮、链接、勾选框上时不算「点这一行」
                  if ((e.target as HTMLElement).closest("a, button, .ant-checkbox-wrapper, .ant-select, .ant-dropdown-trigger")) return;
                  router.push(行链接(r));
                },
                style: { cursor: "pointer" },
              })
            : undefined
        }
        pagination={
          分页
            ? {
                current: 分页.当前页,
                pageSize: 分页.每页,
                total: 分页.总数,
                showTotal: (t) => `共 ${t} 条`,
                showSizeChanger: true,
                onChange: 分页.翻页,
              }
            : false
        }
      />
    </div>
  );
}
