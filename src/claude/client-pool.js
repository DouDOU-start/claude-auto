import { ClaudeWebClient } from "./client.js";

export class ClaudeClientPool {
  constructor(clients) {
    this.clients = clients;
    this.index = 0;
  }

  static async open({ projectRoot, config, log = () => {} }) {
    const clients = [];
    for (let index = 0; index < config.sessionKeys.length; index += 1) {
      log(`正在初始化账号 ${index + 1}/${config.sessionKeys.length}……`);
      try {
        const client = await ClaudeWebClient.open({
          projectRoot,
          sessionKey: config.sessionKeys[index],
          proxyUrl: config.proxyUrl,
          browserPath: config.browserPath,
          headless: config.headless,
        });
        clients.push(client);
        log(`账号 ${index + 1} 初始化成功，组织：${client.orgId.slice(0, 8)}。`);
      } catch (error) {
        log(`账号 ${index + 1} 初始化失败：${error.message}`);
      }
    }
    if (clients.length === 0) throw new Error("没有任何 Claude 账号初始化成功。");
    return new ClaudeClientPool(clients);
  }

  get size() {
    return this.clients.length;
  }

  next() {
    const client = this.clients[this.index % this.clients.length];
    this.index += 1;
    return client;
  }

  async close() {
    await Promise.allSettled(this.clients.map((client) => client.close()));
  }
}
