"use client";

/**
 * 快捷键一览。**只读**——列的是代码里真接了的那几个，不是愿望清单。
 *
 * 为什么值得有一栏：这些键散在四处（⌘K 在 CommandBar、Enter / 斜杠在输入框、
 * ⌘1–9 在桌面端的「前往」菜单），不打开源码没人知道它们存在。
 * 首页输入框下面那行提示只说得下三个，剩下的等于不存在。
 *
 * 加新快捷键时**记得回来加一行**：一份对不上的清单比没有清单更坏。
 */
const 组: { 名: string; 项: { 键: string[]; 说明: string; 仅桌面端?: boolean }[] }[] = [
  {
    名: "到处走",
    项: [
      { 键: ["⌘", "K"], 说明: "跳到任意一页；已经在有输入框的页面上时，光标回到输入框" },
      { 键: ["⌘", "N"], 说明: "在当前页新建——它点的就是页头右上角那个主按钮" },
      { 键: ["⌘", "1"], 说明: "到 ⌘9：跳左栏那几项", 仅桌面端: true },
      { 键: ["⌘", ","], 说明: "打开设置", 仅桌面端: true },
    ],
  },
  {
    名: "问一句的时候",
    项: [
      { 键: ["Enter"], 说明: "发送" },
      { 键: ["Shift", "Enter"], 说明: "换行" },
      { 键: ["/"], 说明: "在空输入框里打斜杠，出命令单" },
      { 键: ["Esc"], 说明: "打断正在答的那一问（页面任何地方按都行）" },
      { 键: ["Ctrl", "C"], 说明: "也能打断——光标在输入框里、又没选中文字时" },
    ],
  },
];

export default function KeymapTab({ 桌面端 }: { 桌面端: boolean }) {
  return (
    <div className="set-body">
      {组.map((g) => {
        const 项 = g.项.filter((x) => !x.仅桌面端 || 桌面端);
        if (!项.length) return null;
        return (
          <div key={g.名} style={{ marginBottom: 22 }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 10 }}>{g.名}</div>
            <div className="keymap">
              {项.map((x) => (
                <div key={x.键.join("+") + x.说明} className="keymap-row">
                  <div className="keymap-keys">
                    {x.键.map((k) => (
                      <kbd key={k}>{k}</kbd>
                    ))}
                  </div>
                  <span>{x.说明}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })}
      <p className="muted" style={{ fontSize: 13, margin: 0 }}>
        {桌面端 ? "⌘ 是 Command 键。" : "Windows / Linux 上把 ⌘ 换成 Ctrl。带 ⌘1–9 和 ⌘, 的那几条只在桌面端有。"}
      </p>
    </div>
  );
}
