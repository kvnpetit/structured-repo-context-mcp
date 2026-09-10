import { readFile, writeFile } from "node:fs/promises";
import { ConventionalChangelog } from "conventional-changelog";
import conventionalCommits from "conventional-changelog-conventionalcommits";

const changelogPath = "CHANGELOG.md";

async function readExistingChangelog(): Promise<string> {
  try {
    return await readFile(changelogPath, "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

const generator = new ConventionalChangelog(process.cwd());
generator.config(conventionalCommits());
generator.readPackage();

let generated = "";
for await (const chunk of generator.write()) {
  generated += chunk;
}

if (generated) {
  const existing = await readExistingChangelog();
  const separator = existing && !generated.endsWith("\n") ? "\n" : "";
  await writeFile(changelogPath, `${generated}${separator}${existing}`, "utf8");
}
