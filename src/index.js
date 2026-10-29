import { Client, Events, GatewayIntentBits } from 'discord.js';
import { env } from './config.js';
import { StateStore } from './store.js';
import { commandDefinitions } from './commands.js';
import { RoomManager } from './rooms.js';
import { handleInteraction } from './interactions.js';
import { initializePanelEmojis } from './ui.js';

if (!env.token || env.token === 'your_discord_bot_token_here') {
  console.error('Missing DISCORD_TOKEN. Add it in your hosting provider variables or a local .env file.');
  process.exit(1);
}

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
const store = new StateStore(env.statePath);
const manager = new RoomManager(client, store, env.graceMs);

client.once(Events.ClientReady, async () => {
  console.log(`🟢 TempVoice logged in as ${client.user.tag} (${client.user.id})`);
  try {
    if (env.guildId) {
      const guild = await client.guilds.fetch(env.guildId);
      const commands = await guild.commands.set(commandDefinitions);
      console.log(`✅ Registered ${commands.size} guild commands in ${guild.name}`);
    } else {
      const commands = await client.application.commands.set(commandDefinitions);
      console.log(`✅ Registered ${commands.size} global commands (may take some time to appear)`);
    }
  } catch (error) {
    console.error('[TempVoice] Slash command registration failed:', error);
  }
  // Non-blocking: default emoji buttons work immediately; custom icons load if Discord allows.
  initializePanelEmojis(client.application).then(count => {
    if (count) for (const id of Object.keys(store.data.rooms)) manager.schedulePanelUpdate(id);
  }).catch(err => console.warn('[TEMPO] Icon initialization skipped:', err));
  await manager.recover();
  manager.startCleanupSweep();
  console.log('✅ TempVoice ready. Run /setup in your server.');
});
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  manager.onVoiceState(oldState, newState).catch(console.error);
});
client.on(Events.InteractionCreate, interaction => {
  handleInteraction(interaction, manager).catch(console.error);
});
client.on(Events.ChannelDelete, channel => {
  if (store.room(channel.id)) manager.forgetRoom(channel.id);
  if (channel.guild) {
    const cfg = store.config(channel.guild.id);
    if (cfg?.hubId === channel.id || cfg?.categoryId === channel.id) {
      store.deleteConfig(channel.guild.id);
      console.warn(`[TempVoice] Config removed in ${channel.guild.id} because its hub/category was deleted. Re-run /setup.`);
    }
  }
});
client.on(Events.Error, e => console.error('[Discord client]', e));
process.on('unhandledRejection', e => console.error('[Unhandled rejection]', e));

client.login(env.token).catch(err => {
  console.error('Discord login failed:', err);
  process.exitCode = 1;
});
