"use client";

import { 登记页面行 } from "@/lib/page-rows";
import { useEffect, useMemo, useRef, useState } from "react";
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
 *   - 主动作不在这张表里，它在页头右上角（每个列表页自己用 PageHead 的 extra 放）。
 *     空状态里那个「新建第一位」是给第一次进来的人的引导，不是它的替代品
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
  /** 筛选栏。空库时整条不渲染 */
  筛选?: React.ReactNode;
  /** 工具栏和表格之间那一条汇总（商机页的「总额 · 加权预测」）。不给就没有 */
  汇总?: React.ReactNode;
  /** 勾了行之后才出现的工具条。不给就不支持多选 */
  批量?: (选中: string[], 清空: () => void) => React.ReactNode;
  加载中?: boolean;
  /** 点一行去哪。给了就整行可点；点在按钮、链接、勾选框上不算 */
  行链接?: (r: T) => string;
  横向?: number;
  /**
   * 不给 = 在浏览器里分页（行已经一次全拿下来了，多数列表页是这样）。
   * 给了 = 服务端分页，由调用方去翻。false = 不分页。
   */
  分页?: { 当前页: number; 每页: number; 总数: number; 翻页: (页: number, 每页: number) => void } | false;
  /**
   * 这一页只取了前 N 条时，库里到底有多少。
   *
   * 2026-09-19 报上来的一类：线索 / 商机 / 联系人 / 跟进四页都是 `take: 300` 配
   * 浏览器端分页，而分页条上的 `showTotal` 数的是**取回来的行**——
   * 库里有 500 条线索的人，页脚白纸黑字写着「共 300 条」。
   * 这不是少显示了 200 条的问题，是页面报了一个错的总数。
   *
   * 说法照 CustomerRoster 那条来：「这里只有最近 N 条，全部 M 条…」。
   * 不给 = 行已经是全部（走服务端分页的 `/customers`，或者本来就取全了）。
   */
  截断?: { 总数: number; 说明?: string };
};

const 列键 = <T,>(c: 列<T>) => String(c.key ?? c.dataIndex);

/**
 * 一行叫什么名字。列表页的行各有各的形状，但「这条记录叫什么」总在这几个字段里的一个。
 * 找不到就不登记这一行——上下文里放一个 id 没有意义。
 */
function 行名(r: object): string | null {
  const o = r as Record<string, unknown>;
  for (const k of ["name", "title", "subject", "customerName"]) if (typeof o[k] === "string" && o[k]) return o[k] as string;
  return null;
}

export default function DataList<T extends { id: string }>({
  页, 列: 全部列, 行, 空库, 空态, 筛选, 汇总, 批量, 加载中, 行链接, 横向, 分页, 截断,
}: Props<T>) {
  const router = useRouter();
  const [选中, set选中] = useState<string[]>([]);

  /**
   * 刚出现的行亮两秒。**不用每个页面告诉我们它刚建了谁**——比一下 id 就知道。
   * 新建完 router.refresh()，这张表就多出一个没见过的 id，那一行就是答案：
   * 「我刚填的东西落在这儿」。原来新建完只有一句 message，人还要自己在列表里找。
   *
   * 一次冒出两个以上陌生 id 的不算：翻页、换筛选会一整页都是没见过的，
   * 那不是「刚建的」，把它们全点亮只会让人以为出了什么事。
   * 第一次挂载也不算——那时整页都是陌生的。
   */
  const 见过 = useRef<Set<string> | null>(null);
  const [新来的, set新来的] = useState<string[]>([]);
  /*
    把这一页上列着的名字登记给 AI 面板（lib/page-rows.ts）。每个列表页都走这里，
    所以不用每页手写；离开这一页时清空，免得渠道页的名单跟着人跑到客户页去。
  */
  useEffect(() => {
    登记页面行(行.map(行名).filter((n): n is string => n !== null));
    return () => 登记页面行([]);
  }, [行]);
  useEffect(() => {
    const ids = 行.map((r) => r.id);
    if (见过.current === null) {
      见过.current = new Set(ids);
      return;
    }
    const 新 = ids.filter((id) => !见过.current!.has(id));
    ids.forEach((id) => 见过.current!.add(id));
    if (新.length === 0 || 新.length > 2) return;
    set新来的(新);
    const t = setTimeout(() => set新来的([]), 2000);
    return () => clearTimeout(t);
  }, [行]);

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
      {/* 工具栏只有一条：搜索 + 筛选在左，列设置顶到最右（设计稿 10-17 的六张列表页都是这个形）。
          主动作（新建 / 记录）不在这儿，它在页头右上角——那是全站找它的地方，
          列表页不该把它藏在筛选中间。 */}
      {!空库 && (
        <div className="list-bar">
          {筛选}
          <span className="list-bar-gap" />
          {可选的.length > 0 && (
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
              <Button icon={<SettingOutlined />} aria-label="选择要显示的列">列</Button>
            </Dropdown>
          )}
        </div>
      )}

      {汇总}

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
        rowClassName={(r) => (新来的.includes(r.id) ? "row-fresh" : "")}
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
          分页 === false
            ? false
            : 分页
              ? {
                  current: 分页.当前页,
                  pageSize: 分页.每页,
                  total: 分页.总数,
                  showTotal: (t) => `共 ${t} 条`,
                  showSizeChanger: true,
                  onChange: 分页.翻页,
                }
              : {
                  pageSize: 20,
                  // 截断时 `t` 是取回来的行数，不是库里的总数——别让它冒充总数
                  showTotal: (t) => (截断 && 截断.总数 > 行.length ? `这里 ${t} 条` : `共 ${t} 条`),
                  showSizeChanger: true,
                }
        }
      />
      {截断 && 截断.总数 > 行.length && (
        <div className="muted" style={{ fontSize: 13, marginTop: 8, textAlign: "right" }}>
          这里只有最近 {行.length} 条，库里一共 {截断.总数} 条{截断.说明 ? `。${截断.说明}` : "——用上面的筛选缩小范围"}
        </div>
      )}
    </div>
  );
}
