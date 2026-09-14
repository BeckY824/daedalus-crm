/**
 * 演示环境横条。
 *
 * 和 TrialBar 不同，这条**永远显示、不能关**。它不是提示，是免责：
 * 演示区所有人共用，任何人录进去的东西别人都看得到。访客不知道这一点的话，
 * 会有人把自己真实的客户名单敲进来——那是我们的责任，不是他的疏忽。
 */
export default function DemoBar() {
  return (
    <div className="demobar">
      <span className="demobar-tag">演示环境</span>
      <span>
        数据是编的，所有访客共用一份，<b>每晚重置</b>。随便点、随便改，但请不要录入真实的客户信息。
      </span>
      <a className="demobar-cta" href="https://ai-daedalus.com/demo.html" target="_blank" rel="noopener">
        想要自己的工作区 →
      </a>
    </div>
  );
}
