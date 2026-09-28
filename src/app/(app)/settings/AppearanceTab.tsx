"use client";

import { useEffect } from "react";
import { useLocalPref } from "@/lib/local-pref";
import { 外观键, 底色表, 主题表, 默认外观, 读外观, 挂外观, type 外观 } from "@/lib/appearance";

/**
 * 外观：这台电脑上的样子。只换值，不动数据，也不影响同事（规则见 lib/appearance.ts）。
 *
 * 两行：底色（原底 / 白底）和主题（现状 / 像素 / 科技 / 高级 / 账簿），两行互不影响、可以任意组合。
 * 主题那一行只在主题多于一套时出现——一个只有一个选项的选择器是在让人找一个不存在的东西。
 * 每个选项带一张小样：看得见选了以后长什么样，比一句说明管用。主题的小样挂 data-skin-preview，
 * 主题样式表对它也生效（skins/*.css 的 token 块同时写在 [data-skin-preview="x"] 上），所以小样就是那套主题本身的值。
 */
export default function AppearanceTab() {
  const [存的, 存] = useLocalPref<Partial<外观>>(外观键, 默认外观);
  const 当前 = 读外观(JSON.stringify(存的));
  // 选完当场生效：<html> 上的属性一换，整页的 token 跟着换，不用刷新
  useEffect(() => 挂外观(当前), [当前.paper, 当前.skin]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="appr">
      <p className="appr-note">只改这台电脑上的样子，不动数据，也不影响同事。（测试包 2）</p>
      <section className="appr-row" aria-labelledby="appr-paper">
        <div className="appr-h" id="appr-paper">底色</div>
        <div className="appr-opts" role="radiogroup" aria-labelledby="appr-paper">
          {底色表.map((x) => (
            <button
              key={x.key}
              type="button"
              role="radio"
              aria-checked={当前.paper === x.key}
              className={`appr-opt${当前.paper === x.key ? " on" : ""}`}
              onClick={() => 存({ ...当前, paper: x.key })}
            >
              <span className={`appr-mini appr-mini-${x.key}`} aria-hidden="true">
                <i className="appr-mini-rail" />
                <i className="appr-mini-card" />
              </span>
              <b>{x.名}</b>
              <span>{x.说明}</span>
            </button>
          ))}
        </div>
      </section>
      {主题表.length > 1 && (
        <section className="appr-row" aria-labelledby="appr-skin">
          <div className="appr-h" id="appr-skin">主题</div>
          <div className="appr-opts" role="radiogroup" aria-labelledby="appr-skin">
            {主题表.map((x) => (
              <button
                key={x.key}
                type="button"
                role="radio"
                aria-checked={当前.skin === x.key}
                className={`appr-opt${当前.skin === x.key ? " on" : ""}`}
                onClick={() => 存({ ...当前, skin: x.key })}
              >
                <span className="appr-mini appr-mini-skin" data-skin-preview={x.key} aria-hidden="true">
                  <i className="appr-mini-rail" />
                  <span className="appr-mini-card">
                    <em>客户 Aa 12</em>
                    <i className="appr-mini-bar" />
                  </span>
                </span>
                <b>{x.名}</b>
                <span>{x.说明}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
