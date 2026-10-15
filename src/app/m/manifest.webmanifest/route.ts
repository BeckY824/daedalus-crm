/** 「添加到主屏幕 / 安装应用」读的清单：名字、图标、全屏打开、从 /m 起 */
export function GET() {
  return Response.json(
    {
      name: "Daedalus CRM",
      short_name: "Daedalus",
      start_url: "/m",
      scope: "/m",
      display: "standalone",
      orientation: "portrait",
      background_color: "#fafafa",
      theme_color: "#fafafa",
      icons: [
        { src: "/apple-icon.png", sizes: "180x180", type: "image/png" },
        { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      ],
    },
    { headers: { "content-type": "application/manifest+json", "cache-control": "public, max-age=3600" } },
  );
}
