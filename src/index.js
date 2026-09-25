/**
 * Cloudflare Worker 入口
 */
import { createApp } from './app.js';

export default {
  async fetch(request, env) {
    return createApp({
      kv: env.KV,
      encryptionKey: env.ENCRYPTION_KEY,
      assets: env.ASSETS,
    })(request);
  },
};
