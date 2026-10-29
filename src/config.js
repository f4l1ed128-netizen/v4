import 'dotenv/config';
import path from 'node:path';

export const env = {
  token: process.env.DISCORD_TOKEN,
  guildId: process.env.GUILD_ID?.trim() || null,
  statePath: path.resolve(process.env.DATA_DIR || './data', 'tempvoice.json'),
  graceMs: Math.max(5, Math.min(300, Number(process.env.EMPTY_GRACE_SECONDS) || 15)) * 1000,
};
