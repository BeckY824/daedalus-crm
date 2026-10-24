"use client";
/**
 * 输入框四周那几样：框里左下角的工具键、框上方那一条、发送 / 打断键、框底下的提示和建议问题。
 * 只管画，状态全在 Composer。
 */
import { Dropdown, Tooltip } from "antd";
import { ArrowUpOutlined, SnippetsOutlined, GlobalOutlined, MailOutlined } from "@ant-design/icons";
import Shortcut from "@/components/Shortcut";
import AskFiles, { type 附件 } from "@/components/AskFiles";
import { AiRemaining } from "@/components/AiCost";
import ResearchModeLine from "@/components/research/ResearchModeLine";
import { 邮件摘要 } from "@/components/research/MailPaste";
import type { 背调价目 } from "@/lib/research/actions";
import type { 邮件信号 } from "@/lib/research/verify/mail";
import type { Suggestion } from "./HomeChat";

export function ComposerTools({ 宽, 背调模式, on切背调, files, setFiles, 在跑, 邮件, on开邮件, 摆粘贴键, on粘贴, on预载 }: {
  宽: boolean;
  背调模式: boolean;
  on切背调: () => void;
  files: 附件[];
  setFiles: (f: 附件[]) => void;
  在跑: boolean;
  邮件: 邮件信号 | null;
  on开邮件: () => void;
  摆粘贴键: boolean;
  on粘贴: () => void;
  /** 指到「粘一段聊天」上就先把导入抽屉的代码拿过来，点下去不用等 */
  on预载: () => void;
}) {
  return (
    <>
      {/* 背调模式开关：和普通问答并列切换，选中有明显的状态（.cli-tool-on） */}
      <button
        type="button"
        className={`cli-tool${宽 ? " cli-tool-t" : ""}${背调模式 ? " cli-tool-on" : ""}`}
        aria-pressed={背调模式}
        aria-label="背调"
        onClick={on切背调}
        title={背调模式 ? "退出背调，回到普通问答" : "背调模式：输入公司名或一句需求，直接上网背调"}
      >
        <GlobalOutlined />
        {宽 && <span>背调</span>}
      </button>
      {!背调模式 && <AskFiles files={files} onChange={setFiles} disabled={在跑} />}
      {背调模式 && (
        <button
          type="button"
          className={`cli-tool${宽 ? " cli-tool-t" : ""}${邮件 ? " cli-tool-on" : ""}`}
          onClick={on开邮件}
          title="把询盘邮件的原文（带邮件头）粘进来：查发件 IP、SPF / DKIM / DMARC、回复地址换没换。只在这台电脑上解析"
          aria-label="粘贴询盘邮件"
        >
          <MailOutlined />
          {宽 && <span>粘贴询盘邮件</span>}
        </button>
      )}
      {/*
        主线入口。和加文件并排——都是「把外面的东西弄进来」，不是「问一句」。
        **窄模式（右侧面板）只留图标**：380 宽那一条里还要塞模型选单和发送键，
        带字的话三样挤在一起，而那一屏本来就是「在别的页面上顺手问一句」，
        粘一段名单是首页的事。
      */}
      {/* 空库的欢迎态上那张「开始」卡已经有一颗「粘一段聊天」，这里不再摆第二颗（审查 D11） */}
      {摆粘贴键 && (
        <button
          type="button"
          className={`cli-tool${宽 ? " cli-tool-t" : ""}`}
          onClick={on粘贴}
          onPointerEnter={on预载}
          onFocus={on预载}
          disabled={在跑}
          title="把一段聊天记录粘进来，切成客户记录"
        >
          <SnippetsOutlined />
          {宽 && <span>粘一段聊天</span>}
        </button>
      )}
    </>
  );
}

export function ComposerTop({ 客户, 背调模式, 邮件, on去掉邮件, 提示粘贴, on切, on不切, 没这个命令, q, cmdMatches, cmdIdx, on选命令 }: {
  客户: string;
  背调模式: boolean;
  邮件: 邮件信号 | null;
  on去掉邮件: () => void;
  提示粘贴: { 文本: string; 行数: number } | null;
  on切: (文本: string) => void;
  on不切: () => void;
  没这个命令: boolean;
  q: string;
  cmdMatches: { cmd: string; hint: string }[];
  cmdIdx: number;
  on选命令: (cmd: string) => void;
}) {
  if (背调模式 && 邮件)
    return (
      /* 带上了一封询盘邮件：这一轮背调会把它认出的几样一起核。点「去掉」就不带 */
      <div className="cli-paste">
        <MailOutlined />
        <span className="cli-paste-t" title={邮件摘要(邮件)}>
          带上询盘邮件：{邮件摘要(邮件)}
        </span>
        <button type="button" className="cli-paste-n" onClick={on去掉邮件}>
          去掉
        </button>
      </div>
    );
  if (提示粘贴)
    return (
      /*
        粘进来的像是一段聊天。**只提示，不自动跑**——这是 2026-09 拍板的那条
        「AI 不自动跑」：一次切分要花一次 AI 次数，得他点。
        右边那个「当成问题问」是给误判留的门，点一次就不再纠缠。
      */
      <div className="cli-paste">
        <SnippetsOutlined />
        <span className="cli-paste-t">
          粘进来 {提示粘贴.行数} 行，像是一段记录——要切成{客户}吗？
        </span>
        <button type="button" className="cli-paste-y" onClick={() => on切(提示粘贴.文本)}>
          切成{客户}
        </button>
        <button type="button" className="cli-paste-n" onClick={on不切}>
          当成问题问
        </button>
      </div>
    );
  if (没这个命令)
    return (
      <div className="cli-cmds">
        <div className="cli-cmd">
          <span className="cli-cmd-k">{q.trim()}</span>
          <span className="cli-cmd-h">没有这个命令。删掉「/」直接问，或者 Esc 清空</span>
        </div>
      </div>
    );
  if (cmdMatches.length > 0)
    return (
      <div className="cli-cmds">
        {cmdMatches.map((c, i) => (
          <div key={c.cmd} className={`cli-cmd${i === cmdIdx ? " cli-cmd-on" : ""}`} onMouseDown={() => on选命令(c.cmd)}>
            <span className="cli-cmd-k">{c.cmd}</span>
            <span className="cli-cmd-h">{c.hint}</span>
          </div>
        ))}
      </div>
    );
  return null;
}

export function SendKey({ 在跑, onStop, canSend, on发 }: { 在跑: boolean; onStop: () => void; canSend: boolean; on发: (排队: boolean) => void }) {
  if (在跑)
    return (
      <Tooltip title="打断（Esc）">
        <button type="button" className="cli-send cli-stop" onClick={onStop} aria-label="打断">
          <span className="cli-stop-sq" />
        </button>
      </Tooltip>
    );
  return (
    <Dropdown
      trigger={["hover"]}
      placement="topRight"
      menu={{
        items: [
          { key: "send", label: <MenuRow label="发送" keys="↵" /> },
          { key: "queue", label: <MenuRow label="排队，等上一问答完再发" keys="⌘↵" /> },
        ],
        onClick: ({ key }) => on发(key === "queue"),
      }}
    >
      <button type="button" className="cli-send" onClick={() => on发(false)} disabled={!canSend} aria-label="发送">
        <ArrowUpOutlined />
      </button>
    </Dropdown>
  );
}

export function ComposerFoot({ 摆建议, suggestions, suggIdx, 空, 在跑, 背调模式, 背调价, AI已用完, on问 }: {
  摆建议: boolean;
  suggestions: Suggestion[];
  suggIdx: number;
  空: boolean;
  在跑: boolean;
  背调模式: boolean;
  背调价: Awaited<ReturnType<typeof 背调价目>> | null;
  AI已用完: boolean;
  on问: (x: Suggestion) => void;
}) {
  return (
    <>
      {/* 4–6 个能直接点的具体问题，就摆在输入框底下——人的视线落在框上。
          ↑↓ 在这里面走，回车发选中的那条 */}
      {摆建议 && (
        <div className="cli-welcome-q">
          {suggestions.map((x, i) => (
            <button key={x.label} type="button" className={`cli-q${i === suggIdx ? " cli-q-on" : ""}`} onClick={() => on问(x)} disabled={AI已用完}>
              {x.label}
            </button>
          ))}
        </div>
      )}

      <div className="cli-hints">
        <span>
          <kbd>Enter</kbd> 发送 · <kbd>Shift+Enter</kbd> 换行 · <kbd>/</kbd> 命令
          {在跑 && (
            <>
              {" · "}
              <kbd>Esc</kbd> 打断 · <kbd><Shortcut>⌘↵</Shortcut></kbd> 排队
            </>
          )}
        </span>
        {/* 免费次数常驻显示。等横条弹出来才知道，人已经在问第五句了。
            每一问、每个建议问题都花 1 次，在这儿说一次，不在每个胶囊上挂角标（components/AiCost.tsx） */}
        {背调模式 ? <ResearchModeLine 价={背调价} /> : <AiRemaining />}
        <span style={{ flex: 1 }} />
        {!空 && suggestions.slice(0, 3).map((x) => (
          <button key={x.label} type="button" className="cli-sugg" disabled={AI已用完} onClick={() => on问(x)}>
            {x.label}
          </button>
        ))}
      </div>
    </>
  );
}

function MenuRow({ label, keys }: { label: string; keys: string }) {
  return (
    <span className="cli-menu-row">
      <span>{label}</span>
      <kbd><Shortcut>{keys}</Shortcut></kbd>
    </span>
  );
}
