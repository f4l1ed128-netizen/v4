import 'dotenv/config';
import { Client, GatewayIntentBits, REST, Routes, Events, MessageFlags } from 'discord.js';
import { Store } from './store.js';
import { Platforms } from './platforms.js';
import { Monitor } from './monitor.js';
import { EventBridge } from './events.js';
import { TwitchSocket } from './twitch-ws.js';
import './tiktok-apify.js'; // always loaded; it only calls Apify when APIFY_TOKEN is set
import { command, handleCommand, handleComponents } from './commands.js';

if (!process.env.DISCORD_TOKEN) {
  console.error('[ALERTS] Missing DISCORD_TOKEN. Set it in your hosting environment variables.');
  process.exit(1);
}
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const store = new Store(process.env.DATA_DIR || './data');
const platforms = new Platforms();
const monitor = new Monitor(client, store, platforms, {
  interval: Number(process.env.POLL_SECONDS || 15),
  notifyOnStartup: process.env.NOTIFY_ON_STARTUP === 'true',
});
const bridge = new EventBridge(monitor, platforms, store);
const twitchSocket = new TwitchSocket(monitor, store);
// Refresh webhook registrations when creators are added or removed.
for (const method of ['add', 'remove']) {
  const original = store[method].bind(store);
  store[method] = (...args) => {
    const result = original(...args);
    if (bridge.enabled && ready) setImmediate(() => bridge.sync().catch(e => console.error('[EVENTS] refresh:', e.message)));
    return result;
  };
}
let ready = false;

client.once(Events.ClientReady, async bot => {
  console.log(`[ALERTS] Logged in as ${bot.user.tag}`);
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    const guildId = process.env.GUILD_ID?.trim();
    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(bot.user.id, guildId), { body: [command.toJSON()] });
      console.log(`[ALERTS] Registered /alerts in guild ${guildId}`);
    } else {
      await rest.put(Routes.applicationCommands(bot.user.id), { body: [command.toJSON()] });
      console.log('[ALERTS] Registered global /alerts command (may take longer to appear)');
    }
    ready = true;
    await monitor.start();
    await bridge.start().catch(e => console.error('[EVENTS] Receiver failed; scheduled scans still running:', e.message));
    await twitchSocket.start().catch(e => console.error('[TWITCH-WS] Failed; scheduled checks still run:', e.message));
    console.log('[ALERTS] Monitoring started. /alerts panel and /alerts add are ready.');
  } catch (e) {
    console.error('[ALERTS] Startup error:', e);
    process.exitCode = 1;
    await client.destroy();
  }
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    if (interaction.isChatInputCommand() && interaction.commandName === 'alerts') {
      await handleCommand(interaction, store, platforms, monitor);
    } else if (interaction.isButton() || interaction.isStringSelectMenu() || interaction.isModalSubmit()) {
      await handleComponents(interaction, store, monitor);
    }
  } catch (e) {
    const msg = `❌ ${String(e?.message || e).slice(0, 1700)}`;
    console.error(`[ALERTS] Interaction failed: ${interaction.customId || interaction.commandName}`, e);
    try {
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content: msg, embeds: [], components: [], allowedMentions: { parse: [] } });
      else await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    } catch (replyError) { console.error('[ALERTS] Cannot reply to interaction:', replyError.message); }
  }
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.once(sig, () => {
    console.log(`[ALERTS] ${sig}: Shutting down`);
    monitor.stop();
    bridge.stop();
    twitchSocket.stop();
    client.destroy().finally(() => process.exit(0));
  });
}
process.on('unhandledRejection', error => console.error('[ALERTS] Unhandled rejection:', error));
client.login(process.env.DISCORD_TOKEN).catch(e => {
  console.error('[ALERTS] Discord login failed:', e.message);
  process.exit(1);
});
