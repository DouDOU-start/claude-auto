import { runRegisterCommand } from "./commands/register.js";

runRegisterCommand().catch((error) => {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
});
