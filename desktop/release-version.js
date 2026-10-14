// The tested maintenance builds belong to the public 0.46.15 release.
// Keep the build version for update ordering and install completion checks:
// testers already have 0.46.16 candidates installed, so the final build is 0.46.17
// (a higher build number reaches them through in-app update) and still shows as 0.46.15.
const PUBLIC_VERSION = { "0.46.16": "0.46.15", "0.46.17": "0.46.15" };

function displayVersion(buildVersion) {
  return PUBLIC_VERSION[String(buildVersion).replace(/^v/, "")] ?? buildVersion;
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
