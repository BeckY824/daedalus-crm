import "./ops.css";

/**
 * 运营台的布局只负责把样式带进来。**外壳（导航）不画在这里**：
 * 布局拿不到网址上的口令，画在这里的话，口令不对时 404 页外面还套着一圈导航——
 * 等于告诉拿不到口令的人「这里有个后台，长这样」。外壳由每一页验完口令之后自己画（OpsShell）。
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return children;
}
