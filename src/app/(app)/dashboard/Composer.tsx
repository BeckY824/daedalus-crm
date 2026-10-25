"use client";
/**
 * 首页 / 右侧面板底下那个输入框，连同它四周的东西：斜杠命令、背调模式、粘一段聊天、询盘邮件、建议问题。
 *
 * 从 HomeChat 里拆出来（2026-10-24）：输入框里的字、命令单选到第几条这些状态，
 * 原来和整列对话放在同一个组件里，打一个字整屏都跟着重渲。现在它们只让这一块重渲。
 */
import { useEffect, useImperativeHandle, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import ModelPicker from "@/components/ModelPicker";
import type { 附件 } from "@/components/AskFiles";
import type { ModelOption } from "@/lib/llm";
import { useBusiness } from "@/lib/business-client";
import { clearJob } from "@/lib/ai-jobs";
import { cancelStream } from "@/lib/ai-stream";
import { addTurn, clearThread, type Turn } from "@/lib/home-thread";
import { 是刚交过来的 } from "@/lib/home-ask";
import AskBox from "@/components/AskBox";
import { 认背调意图 } from "@/lib/research/intent";
import { 认背调对象 } from "@/lib/research/target";
import { 背调价目 } from "@/lib/research/actions";
import MailPaste from "@/components/research/MailPaste";
import { 像邮件原文, type 邮件信号 } from "@/lib/research/verify/mail";
import { 是免费邮箱 } from "@/lib/research/verify/domain";
import { ComposerFoot, ComposerTools, ComposerTop, SendKey } from "./ComposerParts";
import type { Suggestion } from "./HomeChat";
import type { 这一屏 } from "./useHomeTurns";

/*
  导入抽屉不进首页的包：它连着切分、核对、撤销一整套，大多数人打开首页并不粘东西。
  第一次要打开时才去拿，拿到以后一直挂着（关上再开和原来一样，不重新加载）。
  指到「粘一段聊天」上、或框里冒出「要切成客户吗」那条提示时先去拿，点下去基本不用等
*/
const 拿导入抽屉 = () => import("../customers/ImportDrawer");
const ImportDrawer = dynamic(拿导入抽屉, { ssr: false });
function 预载导入抽屉() {
  void 拿导入抽屉();
}

/** 斜杠命令：像 Claude Code 那样，输入 / 弹一张单子 */
const COMMANDS: { cmd: string; hint: string; question: string }[] = [
  { cmd: "/prep", hint: "准备下次跟进：找我最该联系的那位，读完记录给建议", question: "看一下我未完成的跟进计划，挑最该准备的那位，读完记录告诉我这次该谈什么" },
  { cmd: "/recap", hint: "回顾上次沟通：上次跟的那位聊到哪了", question: "找我最近一次跟进的那位，读记录，告诉我上次聊到哪、有什么没接住" },
  { cmd: "/watch", hint: "盯盘：正在被遗忘的人，各自该从哪接上", question: "看盯盘清单，对前几位各给一句现在该从哪接上" },
  { cmd: "/model", hint: "换个模型", question: "" },
  // 左栏那一项叫「数据」，这里也叫「数据」（审查 D3）
  { cmd: "/board", hint: "打开数据", question: "" },
  { cmd: "/clear", hint: "清空这一屏", question: "" },
];

/** 只有一个模型时 /model 按下去什么也不会发生（没有选单可开），就不列出来（审查 D3） */
function 命令表(几个模型: number) {
  return 几个模型 > 1 ? COMMANDS : COMMANDS.filter((c) => c.cmd !== "/model");
}

/** 斜杠命令：自己就做完的（/clear、/board、/model）和打错的返回 null；其余返回要问的那一句 */
function 跑命令(typed: string, c: { 几个模型: number; turns: Turn[]; scope: string; setQ: (v: string) => void; router: ReturnType<typeof useRouter> }) {
  const x = 命令表(c.几个模型).find((y) => y.cmd === typed.split(/\s+/)[0]);
  if (x?.cmd === "/clear") {
    c.turns.forEach((t) => clearJob(`home:${t.id}`));
    clearThread(c.scope);
    c.setQ("");
    return null;
  }
  if (x?.cmd === "/board") {
    c.router.push("/overview");
    return null;
  }
  if (x?.cmd === "/model") {
    // 点开选单本身就是选模型，这里只负责把它亮出来
    c.setQ("");
    document.querySelector<HTMLButtonElement>(".mp-btn")?.click();
    return null;
  }
  // 打错命令：原文留着，下面那行「没有这个命令」已经说了（审查 D3）。原来整行静默清空
  return x ? x.question : null;
}

/** 对话记录那边要借输入框发一句（回答里点的追问）：走同一条路，命令、背调意图、排队都认 */
export type ComposerHandle = { 问: (q: string) => void };

/*
  ── 粘一段聊天 ────────────────────────────────────────────
  主线是「粘一段 → 客户本自己长出来」，而这条路原来藏在客户页的导入抽屉里、
  还是第二个栏位。首页是人每天看的第一屏，入口就该在这儿（2026-09-21）。

  两个入口，都**不自动跑**：
    1. 框里粘进来一段像聊天的东西 → 输入框上方出一条提示，点了才走
    2. 框内左下角一个常驻的按钮 → 空着打开那扇门

  识别只看形状不看内容：**三行以上、六十字以上**才算。一句长问题不该被拦下来问
  「这是不是聊天记录」，而真正的聊天记录几乎不可能只有两行。
*/
function usePaste() {
  const [粘贴开着, set粘贴开着] = useState(false);
  /** 抽屉打开过没有：打开过就一直挂着 */
  const [开过粘贴, set开过粘贴] = useState(false);
  /** 递给抽屉的全文。框里那份被 maxLength 截过，所以单独存一份 */
  const [粘来的, set粘来的] = useState("");
  /** 上方那条提示。人点了「当成问题问」就收起来，不再纠缠 */
  const [提示粘贴, set提示粘贴] = useState<{ 文本: string; 行数: number } | null>(null);

  function 去粘贴(文本: string) {
    set粘来的(文本);
    set提示粘贴(null);
    set粘贴开着(true);
    set开过粘贴(true);
  }
  function 关粘贴() {
    set粘贴开着(false);
    set粘来的("");
  }
  function 提示(文本: string, 行数: number) {
    预载导入抽屉();
    set提示粘贴({ 文本, 行数 });
  }
  return { 粘贴开着, 开过粘贴, 粘来的, 提示粘贴, set提示粘贴, 提示, 去粘贴, 关粘贴 };
}

/*
  背调模式（10-16 用户：「背调可以单独作为一个 agent……在对话那里选择这个，然后直接输入需求，就直接进入背调」）。
  和普通问答并列切换；选中以后发出去的每一句都是一次背调，直接开跑——**选模式本身就是确认**。
  扣的是背调次数（和问答次数分开），输入框底下常驻「背调 · 每次扣 1 次 · 剩 N 次」；没次数就发不出去。
*/
function useResearchMode(runningKey: string | null) {
  const [背调模式, set背调模式] = useState(false);
  /*
    「粘贴询盘邮件」（背调补充方案第二期）：弹窗开着没有、带上了哪封。只存认出来的几样（verify/mail.ts），
    原文在弹窗里解析完就丢了，不进 turn、不进库。发出去那一轮背调带上，带完清掉
  */
  const [邮件框, set邮件框] = useState<{ 初值?: string } | null>(null);
  const [邮件, set邮件] = useState<邮件信号 | null>(null);
  const [背调价, set背调价] = useState<Awaited<ReturnType<typeof 背调价目>> | null>(null);

  /* 进背调模式就问一次价（还剩几次背调）；有一轮跑完（runningKey 变了）再问一次——刚扣过 */
  useEffect(() => {
    if (!背调模式) return;
    let 活 = true;
    背调价目()
      .then((r) => 活 && set背调价(r))
      .catch(() => 活 && set背调价({ 可用: false, 原因: "问不到背调次数，稍后再试" }));
    return () => {
      活 = false;
    };
  }, [背调模式, runningKey]);

  /** 背调模式能不能发：这台机器能背调、背调次数还有（不限 = 测试账号 / 开发环境的模拟） */
  const 背调能发 = Boolean(背调价?.可用 && (背调价.还剩 == null || 背调价.还剩 >= 背调价.扣次));
  return { 背调模式, set背调模式, 邮件框, set邮件框, 邮件, set邮件, 背调价, 背调能发 };
}

/**
 * 把输入框实测高度写进 --cli-composer-h，供 scroll-margin 和「贴着底部」判断用。
 * 它会随输入的文字长高（上限见 globals.css 里 .cli-input textarea 的 max-height），写死一个常数迟早对不上。
 */
function useComposerHeight(composerRef: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    const 量 = () => document.documentElement.style.setProperty("--cli-composer-h", `${Math.round(el.getBoundingClientRect().height)}px`);
    量();
    const ro = new ResizeObserver(量);
    ro.observe(el);
    return () => ro.disconnect();
  }, [composerRef]);
}

export default function Composer({ ref, 屏, scope, models, model, 模式, suggestions, 空库, on发出 }: {
  ref?: React.Ref<ComposerHandle>;
  屏: 这一屏;
  scope: string;
  models: ModelOption[];
  model: string;
  模式: "宽" | "窄";
  suggestions: Suggestion[];
  空库: boolean;
  /** 刚发出去的那一问。只有它会在挂载时把自己滚到视口顶部，翻历史不该乱跳 */
  on发出: (id: string) => void;
}) {
  const { turns, running, runningKey, start, AI已用完 } = 屏;
  const b = useBusiness();
  const router = useRouter();
  const 地址栏 = useSearchParams();
  /** 这一问要带的文件。发出去就清空——它属于那一问，不属于这个输入框 */
  const [files, setFiles] = useState<附件[]>([]);
  const 粘 = usePaste();
  const 调 = useResearchMode(runningKey);
  const { 背调模式, 邮件 } = 调;
  /*
    初值就是地址上的 q（2026-10-04，J-158）：外面来的 /dashboard?q=… 只把问题填进来等回车；
    是本应用 ⌘K 交过来的，下面那个 effect 会直接发出去（submit 会把框清空）
  */
  const [q, setQ] = useState(() => 地址栏.get("q") ?? "");
  const [cmdIdx, setCmdIdx] = useState(0);
  /** 输入框空着时，↑↓ 在下面那排建议问题里选，回车就发。-1 = 没选 */
  const [suggIdx, setSuggIdx] = useState(-1);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  useComposerHeight(composerRef);

  function 认一下粘的是什么(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const 全文 = e.clipboardData?.getData("text") ?? "";
    // 背调模式里粘进来一封邮件原文：不往框里塞（几百行邮件头），直接打开「粘贴询盘邮件」，在本机解析
    if (背调模式 && 像邮件原文(全文)) {
      e.preventDefault();
      调.set邮件框({ 初值: 全文 });
      return;
    }
    const 行数 = 全文.split(/\r?\n/).filter((l) => l.trim()).length;
    if (行数 >= 3 && 全文.trim().length >= 60) 粘.提示(全文, 行数);
  }

  /** 发出去以后输入框这边要清的 */
  function 发完(id: string) {
    on发出(id);
    setQ("");
    setFiles([]);
  }

  function submit(raw: string, opts: { queue?: boolean } = {}) {
    const typed = raw.trim();
    if (!typed) return;
    /*
      背调模式：这一句就是要背调的对象（可以是公司名、官网、或一句需求）。认得出是哪家就直接开跑；
      认不准（好几家 / 太短 / 认不出）先摆一张点选卡，不扣次数（lib/research/target.ts）。
      问答次数用完了不挡——背调次数是另一本账
    */
    if (背调模式) {
      if (!调.背调能发) return;
      const 对象 = 认背调对象(typed);
      const turn = addTurn(scope, {
        question: typed,
        kind: "research",
        直接: true,
        需求: typed,
        ...(对象.种类 === "公司" ? { 公司: 对象.公司 } : 对象.种类 === "人" ? { 人: { 名: 对象.名, 电话: 对象.电话 } } : { 待选: 对象 }),
        ...(邮件 ? { 邮件 } : {}),
      });
      调.set邮件(null);
      发完(turn.id);
      return;
    }
    const question = typed.startsWith("/") ? 跑命令(typed, { 几个模型: models.length, turns, scope, setQ, router }) : typed;
    if (question == null || question.length < 2 || AI已用完) return;
    /*
      「帮我背调 XX」：不走 agent（那条路没有联网搜索，还会白扣一次），直接摆一张背调确认卡。
      不排队——确认卡本身不调模型，人点了「开始」才跑
    */
    const 背调公司 = typed.startsWith("/") ? null : 认背调意图(question);
    if (背调公司) {
      发完(addTurn(scope, { question, kind: "research", 公司: 背调公司 }).id);
      return;
    }
    // 正在答的时候再发：排队，不并发打模型
    const shouldQueue = opts.queue || Boolean(running);
    const turn = addTurn(scope, {
      question,
      kind: "ask",
      queued: shouldQueue,
      files: files.length ? files.map((f) => ({ name: f.name, text: f.text })) : undefined,
    });
    if (!shouldQueue) start(turn);
    发完(turn.id);
  }
  useImperativeHandle(ref, () => ({ 问: (x: string) => submit(x) }));
  // 放在 submit 定义之后：effect 里提前用到后面才声明的函数，React 编译器的检查不认
  useAddressAsk(submit);

  function stop() {
    if (running) cancelStream(`home:${running.id}`);
    taRef.current?.focus();
  }

  const empty = turns.length === 0;
  const showCmds = q.startsWith("/") && !q.includes(" ");
  const cmdMatches = showCmds ? 命令表(models.length).filter((c) => c.cmd.startsWith(q.trim())) : [];
  /** 打了一个斜杠开头、却一条命令都对不上：就地说一句，不再回车后整行静默清空 */
  const 没这个命令 = showCmds && q.trim().length > 1 && cmdMatches.length === 0;
  const canSend = q.trim().length > 0 && (背调模式 ? 调.背调能发 : !AI已用完);
  /** 输入框底下摆不摆那排建议问题：只在还没问过、且库里有东西的时候 */
  const 摆建议 = empty && !空库 && suggestions.length > 0 && 模式 === "宽";
  const 问这条 = (x: Suggestion) => submit(x.kind === "prep" ? "/prep" : x.kind === "recap" ? "/recap" : x.question);
  const 宽 = 模式 === "宽";

  return (
    <>
      <div ref={composerRef} className={`cli-composer${empty ? "" : " cli-composer-sticky"}`}>
        <AskBox
          引用={taRef}
          value={q}
          onChange={(v) => {
            setQ(v);
            setCmdIdx(0);
          }}
          onSubmit={() => submit(cmdMatches.length ? cmdMatches[cmdIdx].cmd : q)}
          onPaste={认一下粘的是什么}
          placeholder={
            背调模式
              ? "输入公司名、官网或一句需求，比如：帮我查 Rexel 适不适合我们"
              : running
                ? "正在回答… 再问会排队，Esc 打断"
                : `问一位${b.customer}，或问一个数`
          }
          栏左={
            <ComposerTools
              宽={宽}
              背调模式={背调模式}
              on切背调={() => {
                调.set背调模式((v) => !v);
                taRef.current?.focus();
              }}
              files={files}
              setFiles={setFiles}
              在跑={running != null}
              邮件={邮件}
              on开邮件={() => 调.set邮件框({})}
              摆粘贴键={!背调模式 && !(empty && 空库 && 宽)}
              on粘贴={() => 粘.去粘贴("")}
              on预载={预载导入抽屉}
            />
          }
          栏右={<ModelPicker options={models} value={model} />}
          上方={
            <ComposerTop
              客户={b.customer}
              背调模式={背调模式}
              邮件={邮件}
              on去掉邮件={() => 调.set邮件(null)}
              提示粘贴={粘.提示粘贴}
              on切={粘.去粘贴}
              on不切={() => 粘.set提示粘贴(null)}
              没这个命令={没这个命令}
              q={q}
              cmdMatches={cmdMatches}
              cmdIdx={cmdIdx}
              on选命令={(c) => submit(c)}
            />
          }
          发送={<SendKey 在跑={running != null} onStop={stop} canSend={canSend} on发={(排队) => submit(q, { queue: 排队 })} />}
          onKeyDown={(e) =>
            按键(e, { q, setQ, cmdMatches, cmdIdx, setCmdIdx, showCmds, 摆建议, suggestions, suggIdx, setSuggIdx, 提示粘贴: 粘.提示粘贴, 收起提示: () => 粘.set提示粘贴(null), 在跑: running != null, stop, 问这条, submit })
          }
        />

        <ComposerFoot 摆建议={摆建议} suggestions={suggestions} suggIdx={suggIdx} 空={empty} 在跑={running != null} 背调模式={背调模式} 背调价={调.背调价} AI已用完={AI已用完} on问={问这条} />
      </div>

      <ComposerDoors 粘={粘} 调={调} aiEnabled={models.length > 0} q={q} setQ={setQ} taRef={taRef} />
    </>
  );
}

/**
 * ⌘K 里直接问的那一句会带在地址上（/dashboard?q=…）。
 * 到了这儿就发出去，然后把 q 从地址里抹掉——留着的话刷新一次会再问一遍。
 *
 * **只有本应用 ⌘K 刚交过来的才自动发**（2026-10-04，J-158）：别人发来的链接、收藏夹里的地址点开，
 * 只把问题填进输入框、光标放进去，等人自己按回车——不然点一下链接就白扣一次次数。见 lib/home-ask.ts
 *
 * 那个 ref 不是多余的：开发模式下 StrictMode 会把 effect 跑两遍（挂载 → 清理 → 再挂载），
 * 而 router.replace 生效没那么快，结果就是同一句话问了两遍、扣两次额度。
 */
function useAddressAsk(submit: (q: string) => void) {
  const router = useRouter();
  const 地址栏 = useSearchParams();
  const 已消化地址问句 = useRef(false);
  useEffect(() => {
    const q0 = 地址栏.get("q");
    if (!q0 || 已消化地址问句.current) return;
    已消化地址问句.current = true;
    router.replace("/dashboard");
    // 放进微任务里发：submit 会改输入框等状态，effect 体里同步 setState 会连着多渲染一轮（react-hooks/set-state-in-effect）
    if (是刚交过来的(q0)) queueMicrotask(() => submit(q0));
    // 只认挂载时地址上的那一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/** 输入框打开的两扇门：粘一段聊天的导入抽屉、粘贴询盘邮件的框 */
function ComposerDoors({ 粘, 调, aiEnabled, q, setQ, taRef }: {
  粘: ReturnType<typeof usePaste>;
  调: ReturnType<typeof useResearchMode>;
  aiEnabled: boolean;
  q: string;
  setQ: (v: string) => void;
  taRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const b = useBusiness();
  const router = useRouter();
  return (
    <>
      {/*
        「粘一段聊天」那扇门。复用客户页那个导入抽屉——切分、两条核对（抓编造、抓漏人）、
        整批可撤销全在里面，主线入口不该另起一套规矩。
        aiEnabled 按「有没有模型可选」判：和右边那个模型选单同一个依据。
      */}
      {粘.开过粘贴 && (
        <ImportDrawer
          open={粘.粘贴开着}
          b={b}
          aiEnabled={aiEnabled}
          初始来路="文本"
          初始文本={粘.粘来的}
          onClose={粘.关粘贴}
          onDone={() => router.refresh()}
        />
      )}
      <MailPaste
        open={调.邮件框 != null}
        初值={调.邮件框?.初值}
        onCancel={() => 调.set邮件框(null)}
        onOk={(x) => {
          调.set邮件(x);
          调.set邮件框(null);
          // 框里还空着：用发件人的域名先填上（企业邮箱的域名多半就是官网），人可以改成公司名
          if (!q.trim() && x.发件人 && !是免费邮箱(x.发件人)) setQ(x.发件人.split("@")[1]);
          taRef.current?.focus();
        }}
      />
    </>
  );
}

/** 输入框里的按键：建议问题和命令单里走、Esc 收起上面那一层、Tab 补全命令、Ctrl+C 打断、回车发送 / ⌘↵ 排队 */
function 按键(
  e: React.KeyboardEvent<HTMLTextAreaElement>,
  c: {
    q: string;
    setQ: (v: string) => void;
    cmdMatches: { cmd: string }[];
    cmdIdx: number;
    setCmdIdx: React.Dispatch<React.SetStateAction<number>>;
    showCmds: boolean;
    摆建议: boolean;
    suggestions: Suggestion[];
    suggIdx: number;
    setSuggIdx: React.Dispatch<React.SetStateAction<number>>;
    提示粘贴: unknown;
    收起提示: () => void;
    在跑: boolean;
    stop: () => void;
    问这条: (x: Suggestion) => void;
    submit: (raw: string, opts?: { queue?: boolean }) => void;
  },
) {
  const { q, cmdMatches, cmdIdx, suggestions, suggIdx } = c;
  // 输入框空着、下面摆着建议问题时，↑↓ 在建议里走，回车发选中的那条
  if (!cmdMatches.length && !q && c.摆建议 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    e.preventDefault();
    c.setSuggIdx((i) => {
      const n = suggestions.length;
      if (e.key === "ArrowDown") return i + 1 >= n ? 0 : i + 1;
      return i <= 0 ? n - 1 : i - 1;
    });
    return;
  }
  if (cmdMatches.length && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    e.preventDefault();
    c.setCmdIdx((i) => (i + (e.key === "ArrowDown" ? 1 : cmdMatches.length - 1)) % cmdMatches.length);
    return;
  }
  // Esc 先关斜杠菜单 / 「没有这个命令」 / 粘贴提示这一层，不往下传去打断回答
  if (e.key === "Escape" && !e.nativeEvent.isComposing && (c.showCmds || c.提示粘贴)) {
    e.preventDefault();
    if (c.提示粘贴) c.收起提示();
    else c.setQ("");
    return;
  }
  if (cmdMatches.length && e.key === "Tab") {
    e.preventDefault();
    c.setQ(cmdMatches[cmdIdx].cmd + " ");
    return;
  }
  // Ctrl+C（Codex 的习惯）：没选中文字时当打断用
  if (e.ctrlKey && e.key === "c" && c.在跑 && e.currentTarget.selectionStart === e.currentTarget.selectionEnd) {
    e.preventDefault();
    c.stop();
    return;
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    if (!cmdMatches.length && !q && suggIdx >= 0 && suggestions[suggIdx]) {
      c.问这条(suggestions[suggIdx]);
      c.setSuggIdx(-1);
      return;
    }
    c.submit(cmdMatches.length ? cmdMatches[cmdIdx].cmd : q, { queue: e.metaKey || e.ctrlKey });
  }
}
