import { resolve } from "node:path";
import { installProjectBrowser, projectBrowserCandidates } from "./browser-utils.js";

const projectRoot = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const existingBrowser = projectBrowserCandidates(projectRoot)[0] || "";

if (existingBrowser) {
  console.log(`[browser] Chromium already installed: ${existingBrowser}`);
} else {
  installProjectBrowser(projectRoot);
}
