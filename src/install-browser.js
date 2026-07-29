import { resolve } from "node:path";
import { installProjectBrowser, projectBrowserCandidates } from "./browser-utils.js";

const projectRoot = resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const existingBrowser = projectBrowserCandidates(projectRoot)[0] || "";

if (existingBrowser) {
  console.log(`[浏览器] Chromium 已安装：${existingBrowser}`);
} else {
  installProjectBrowser(projectRoot);
}
