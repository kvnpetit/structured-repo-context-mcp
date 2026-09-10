import { readFileSync } from "node:fs";

const changelogPath = "CHANGELOG.md";
const changelog = readFileSync(changelogPath, "utf8").replaceAll("\r\n", "\n");
const lines = changelog.split("\n");
const errors: string[] = [];
const allowedSections = new Set(["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"]);
const versionHeading = /^## \[([0-9]+\.[0-9]+\.[0-9]+)\] - (\d{4}-\d{2}-\d{2})$/;
const h2Indexes = lines.flatMap((line, index) => (line.startsWith("## ") ? [index] : []));
const unreleasedIndex = lines.indexOf("## [Unreleased]");
const versions: Array<{ version: string; date: string; line: number }> = [];

if (lines[0] !== "# Changelog") {
  errors.push("the file must start with '# Changelog'");
}
if (!changelog.includes("https://keepachangelog.com/en/2.0.0/")) {
  errors.push("the preamble must declare Keep a Changelog 2.0.0");
}
if (!changelog.includes("https://semver.org/spec/v2.0.0.html")) {
  errors.push("the preamble must declare Semantic Versioning");
}
if (unreleasedIndex === -1) {
  errors.push("an '## [Unreleased]' section is required at the top");
} else if (unreleasedIndex !== h2Indexes[0]) {
  errors.push("the '## [Unreleased]' section must be the first release section");
}

for (const index of h2Indexes) {
  const line = lines[index] ?? "";
  if (line === "## [Unreleased]") {
    continue;
  }
  const match = versionHeading.exec(line);
  if (!match) {
    errors.push(`line ${index + 1}: release headings must use '## [x.y.z] - YYYY-MM-DD'`);
    continue;
  }
  const version = match[1];
  const date = match[2];
  if (!version || !date) {
    errors.push(`line ${index + 1}: release heading is missing its version or date`);
    continue;
  }
  if (versions.some((entry) => entry.version === version)) {
    errors.push(`line ${index + 1}: duplicate release version ${version}`);
  }
  const dateValue = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(dateValue.getTime()) || dateValue.toISOString().slice(0, 10) !== date) {
    errors.push(`line ${index + 1}: invalid release date ${date}`);
  }
  versions.push({ version, date, line: index + 1 });
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    }
  }
  return 0;
}

for (let index = 1; index < versions.length; index += 1) {
  const previous = versions[index - 1];
  const current = versions[index];
  if (previous && current && compareVersions(previous.version, current.version) <= 0) {
    errors.push(
      `line ${current.line}: release versions must be newest first (${previous.version} before ${current.version})`,
    );
  }
}

for (const headingIndex of h2Indexes) {
  const heading = lines[headingIndex] ?? "";
  const nextHeadingIndex = h2Indexes.find((index) => index > headingIndex) ?? lines.length;
  for (let index = headingIndex + 1; index < nextHeadingIndex; index += 1) {
    const section = /^### (.+)$/.exec(lines[index] ?? "")?.[1];
    if (section && !allowedSections.has(section)) {
      errors.push(`line ${index + 1}: unsupported changelog category '${section}'`);
    }
  }
  if (heading === "## [Unreleased]" || versionHeading.test(heading)) {
    const label = heading === "## [Unreleased]" ? "Unreleased" : versionHeading.exec(heading)?.[1];
    if (!label) {
      continue;
    }
    const reference = new RegExp(`^\\[${label.replaceAll(".", "\\.")}\\]:\\s+\\S+$`, "m");
    if (!reference.test(changelog)) {
      errors.push(`line ${headingIndex + 1}: missing reference link for [${label}]`);
    }
  }
}

if (errors.length > 0) {
  console.error(`${changelogPath} failed Keep a Changelog validation:`);
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exitCode = 1;
} else {
  console.log(`${changelogPath} follows Keep a Changelog categories and release ordering.`);
}
