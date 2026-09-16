"use client";

import { useState } from "react";
import { Alert } from "antd";
import AskBox from "@/components/AskBox";
import { askData, type AskResult } from "./ask";
import AskDataResult from "./AskDataResult";
import { useBusiness } from "@/lib/business-client";

/**
 * 「数据」页上的问数据。
 *
 * 框是和首页同一个（components/AskBox），所以边框、字号、Enter 发送、⌘K 聚焦
 * 全都一致——原来这里是 antd 的 Input.Search，和首页那个长得完全不像。
 *
 * 答的东西不一样，所以答案怎么画各管各的：这里问的是一个数，给一句结论加一张图；
 * 首页问的是一位学员接下来怎么办，给的是一段话加可确认的建议卡。
 * 不做对话历史——报表要的是当下这个数，翻旧账不如重问一遍。
 */
export default function AskData() {
  const b = useBusiness();
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AskResult | null>(null);
  const [问的是, set问的是] = useState("");

  async function ask() {
    const 问题 = q.trim();
    if (!问题 || loading) return;
    setLoading(true);
    setError(null);
    set问的是(问题);
    const res = await askData(问题);
    setLoading(false);
    setQ("");
    if (res.ok) setResult(res.result);
    else {
      setResult(null);
      setError(res.error);
    }
  }

  return (
    <div className="askdata">
      <AskBox
        value={q}
        onChange={setQ}
        onSubmit={ask}
        disabled={loading}
        maxLength={300}
        placeholder={`问一个数，比如「这个月哪个销售新增${b.customer}最多」`}
        底部={
          <div className="cli-hints">
            <span>
              问的是库里的真实数字，不是估的。<kbd>Enter</kbd> 发送 · <kbd>⌘K</kbd> 回到这里
            </span>
          </div>
        }
      />
      {loading && <div className="askdata-wait">正在查…</div>}
      {error && <Alert type="warning" showIcon title={error} style={{ marginTop: 12 }} />}
      {result && !loading && (
        <div className="askdata-out">
          <div className="askdata-q">问：{问的是}</div>
          <AskDataResult result={result} />
        </div>
      )}
    </div>
  );
}
