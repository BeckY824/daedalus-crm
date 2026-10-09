// The tested maintenance build belongs to the public 0.46.15 release.
// Keep the build version for update ordering and install completion checks.
function displayVersion(buildVersion) {
  return String(buildVersion).replace(/^v/, "") === "0.46.16" ? "0.46.15" : buildVersion;
}

function displayReleaseNotes(entries) {
  const result = [];
  for (const entry of entries) {
    const version = displayVersion(entry.版本);
    const previous = result.at(-1);
    if (previous?.版本 === version) previous.正文 += "\n\n" + entry.正文;
    else result.push({ ...entry, 版本: version });
  }
  return result;
}

module.exports = { displayVersion, displayReleaseNotes };
