import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const projectRoot = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const files = collectJavaScript(join(projectRoot, "src"));
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], { stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status || 1);
}

const tests = spawnSync(process.execPath, ["--test"], {
  cwd: projectRoot,
  stdio: "inherit",
});
process.exitCode = tests.status || 0;

function collectJavaScript(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectJavaScript(path));
    if (entry.isFile() && entry.name.endsWith(".js")) files.push(path);
  }
  return files.sort();
}
