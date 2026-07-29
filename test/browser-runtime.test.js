import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeBrowserProfile } from "../src/core/browser-runtime.js";

test("复用浏览器 profile 时不会覆盖已有状态文件", async () => {
  const directory = await mkdtemp(join(tmpdir(), "claude-profile-test-"));
  try {
    await mkdir(join(directory, "Default"), { recursive: true });
    await writeBrowserProfile(directory);
    const preferences = join(directory, "Default", "Preferences");
    await writeFile(preferences, '{"保留":true}', "utf8");
    await writeBrowserProfile(directory);
    assert.equal(await readFile(preferences, "utf8"), '{"保留":true}');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
