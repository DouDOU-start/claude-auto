import { runRegisterBatchCommand } from "./commands/register-batch.js";

runRegisterBatchCommand().catch((error) => {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
});
