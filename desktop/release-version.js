// 包里的版本号就是用户看到的版本号：0.46.15 起不再有「内部构建号 → 公开版本号」的映射，
// 更新内容也按 CHANGELOG 一版一段原样给。
// 两个函数留着、原样返回，调用方（main.js、WhatsNew、whats-new-actions、smoke-windows-update）不用改；
// 以后真要再分开显示，只改这一处。
function displayVersion(buildVersion) {
  return buildVersion;
}

function displayReleaseNotes(entries) {
  return [...entries];
}

module.exports = { displayVersion, displayReleaseNotes };
