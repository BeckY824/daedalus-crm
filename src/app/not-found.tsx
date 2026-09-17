import StatePage from "@/components/StatePage";

/**
 * 顶层 404：地址根本不对应任何一条路由的时候（`/students`、手打错的路径、旧书签）。
 *
 * **和 `(app)/not-found.tsx` 不是一回事**，两个都要有。
 * 那一个是「路由对、记录没了」（`/customers/已删掉的 id`），它渲染在应用壳里面，
 * 左边侧栏还在，所以只要把人送回列表。
 * 这一个渲染在壳外面——没有侧栏，没有导航，一个字都没有的时候
 * Next 会兜出它自带的那张英文 `404 | This page could not be found`，
 * 中文产品里突然冒出一行英文系统页，比 404 本身更让人愣住。
 *
 * 所以这里自己画一张，规矩和其余三态一样：发生了什么、为什么、接下来做什么。
 */
export const metadata = { title: "没有找到这个页面 · Daedalus CRM" };

export default function NotFound() {
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
      <StatePage
        标题="没有找到这个页面"
        说明="这个地址不对应任何一个页面——可能是链接打错了，也可能是这一页改过地址。回首页从侧栏走一遍最快。"
        动作={{ label: "回首页", href: "/dashboard" }}
        次动作={{ label: "去登录", href: "/login" }}
      />
    </div>
  );
}
