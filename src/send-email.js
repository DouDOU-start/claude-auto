import { runSendVerificationCommand } from "./commands/send-verification.js";

runSendVerificationCommand().catch((error) => {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
});
