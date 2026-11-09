import {
  SlashCommandBuilder, PermissionFlagsBits, ChannelType, MessageFlags,
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import { DEFAULT_TEMPLATE, DEFAULT_VIDEO_TEMPLATE, renderTemplate } from './template.js';
import { normalizeUploadMode, supportsVideoUploads } from './uploads.js';
import { parseCreator } from './platforms.js';

const EPHEMERAL = MessageFlags.Ephemeral;
const COLORS = 0x5865f2;
const choices = ['twitch', 'kick', 'youtube', 'tiktok'].map(n => ({ name: n[0].toUpperCase() + n.slice(1), value: n }));
const modeChoices = ['none', 'everyone', 'here', 'role'].map(n => ({ name: n, value: n }));
const uploadModes = [{ name: 'Streams only', value: 'streams' }, { name: 'Videos only', value: 'videos' }, { name: 'Both streams and videos', value: 'both' }];

export const command = new SlashCommandBuilder().setName('alerts').setDescription('Manage streamer live notifications')
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand(s => s.setName('add').setDescription('Track streams and new videos from a creator')
    .addStringOption(o => o.setName('platform').setDescription('Streaming website').setRequired(true).addChoices(...choices))
    .addStringOption(o => o.setName('creator').setDescription('Streamer profile link or @username').setRequired(true))
    .addChannelOption(o => o.setName('channel').setDescription('Where notifications are sent').setRequired(true)
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    .addStringOption(o => o.setName('display_name').setDescription('Optional custom creator name').setMaxLength(64))
    .addStringOption(o => o.setName('notify').setDescription('YouTube/TikTok: streams, videos or both (default: both)').addChoices(...uploadModes)))
  .addSubcommand(s => s.setName('list').setDescription('View linked streamers'))
  .addSubcommand(s => s.setName('type').setDescription('Change YouTube or TikTok notification types')
    .addStringOption(o => o.setName('id').setDescription('Subscription ID').setRequired(true))
    .addStringOption(o => o.setName('notify').setDescription('Notify when').setRequired(true).addChoices(...uploadModes)))
  .addSubcommand(s => s.setName('video_message').setDescription('Customize a YouTube or TikTok video announcement')
    .addStringOption(o => o.setName('id').setDescription('Subscription ID').setRequired(true))
    .addStringOption(o => o.setName('text').setDescription('Use {creator}, {title}, {url}, {ping}').setRequired(true).setMaxLength(1800)))
  .addSubcommand(s => s.setName('video_ping').setDescription('Set ping mode for YouTube/TikTok video uploads')
    .addStringOption(o => o.setName('id').setDescription('Subscription ID').setRequired(true))
    .addStringOption(o => o.setName('mode').setDescription('Ping mode').setRequired(true).addChoices(...modeChoices))
    .addRoleOption(o => o.setName('role').setDescription('Role if mode is role')))
  .addSubcommand(s => s.setName('message').setDescription('Edit notification text using placeholders')
    .addStringOption(o => o.setName('id').setDescription('ID from /alerts list').setRequired(true))
    .addStringOption(o => o.setName('text').setDescription('Use {creator} {platform} {title} {url} {viewers} {ping}').setRequired(true).setMaxLength(1800)))
  .addSubcommand(s => s.setName('ping').setDescription('Set @everyone, @here, role or no ping')
    .addStringOption(o => o.setName('id').setDescription('ID from /alerts list').setRequired(true))
    .addStringOption(o => o.setName('mode').setDescription('Ping mode').setRequired(true).addChoices(...modeChoices))
    .addRoleOption(o => o.setName('role').setDescription('Role to ping when mode is role')))
  .addSubcommand(s => s.setName('channel').setDescription('Change announcement channel')
    .addStringOption(o => o.setName('id').setDescription('Subscription ID').setRequired(true))
    .addChannelOption(o => o.setName('channel').setDescription('Destination').setRequired(true)
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)))
  .addSubcommand(s => s.setName('remove').setDescription('Stop tracking a creator')
    .addStringOption(o => o.setName('id').setDescription('Subscription ID').setRequired(true)))
  .addSubcommand(s => s.setName('test').setDescription('Send a sample notification (including selected ping)')
    .addStringOption(o => o.setName('id').setDescription('Subscription ID').setRequired(true))
    .addStringOption(o => o.setName('kind').setDescription('Test stream or new video').addChoices({ name: 'Stream', value: 'stream' }, { name: 'Video upload', value: 'video' })))
  .addSubcommand(s => s.setName('check').setDescription('Check a creator status now (does not send alert)')
    .addStringOption(o => o.setName('id').setDescription('Subscription ID').setRequired(true))
    .addStringOption(o => o.setName('kind').setDescription('Check stream or latest video uploads').addChoices({ name: 'Stream', value: 'stream' }, { name: 'Latest videos', value: 'video' })))
  .addSubcommand(s => s.setName('panel').setDescription('Open the interactive management panel'))
  .addSubcommand(s => s.setName('status').setDescription('Show monitoring and API setup status'));

function guard(i) {
  if (!i.inGuild() || !i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
    throw new Error('You need **Manage Server** permission to configure notifications.');
  }
}
function reply(text) { return { content: text, flags: EPHEMERAL, allowedMentions: { parse: [] } }; }
function linkId(id) { return `\`${id}\``; }
function getSub(i, store, id) {
  const item = store.find(i.guildId, id);
  if (!item) throw new Error('Unknown subscription ID. Run `/alerts list` first.');
  return item;
}
function ensureChannel(channel, guild) {
  if (!channel || channel.guildId !== guild.id || ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)) {
    throw new Error('Select a text or announcement channel in this server.');
  }
  // The live sender validates effective Send Messages permission when posting.
}
function selectOptions(store, guildId) {
  return store.list(guildId).slice(0, 25).map(s => ({ label: `${s.displayName || s.username}`.slice(0, 70),
    value: s.id, description: `${s.platform.toUpperCase()} • ${s.id}` }));
}
function panel(store, guildId, selectedId = null) {
  const all = store.list(guildId);
  const selected = all.find(s => s.id === selectedId) || all[0];
  const embed = new EmbedBuilder().setColor(COLORS).setTitle('🔴 Creator Alerts — Control Panel')
    .setDescription(all.length ? `Tracking **${all.length}** creators. Select one below to edit its message or test an alert.\n\n**Selected:** ${selected.displayName || selected.username} (${selected.platform.toUpperCase()})\n**Channel:** <#${selected.destinationId}>\n**Stream ping:** ${selected.pingMode}${selected.roleId ? ` <@&${selected.roleId}>` : ''}\n**Alerts:** ${normalizeUploadMode(selected.platform, selected.mode)}\n**Last status:** ${selected.lastStatus || 'Pending'}` : 'No creators linked. Use `/alerts add` to begin.')
    .setFooter({ text: 'Only members with Manage Server can use these controls.' });
  const components = [];
  if (all.length) {
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder().setCustomId('alerts:select').setPlaceholder('Choose a creator')
        .addOptions(selectOptions(store, guildId).map(o => ({ ...o, default: o.value === selected.id })))));
    components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`alerts:edit:${selected.id}`).setLabel('Edit message').setEmoji('✏️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`alerts:ping:${selected.id}`).setLabel('Ping settings').setEmoji('🔔').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`alerts:test:${selected.id}`).setLabel('Test alert').setEmoji('🧪').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`alerts:refresh:${selected.id}`).setLabel('Refresh').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    ));
    if (supportsVideoUploads(selected.platform)) components.push(new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`alerts:videoedit:${selected.id}`).setLabel('Video message').setEmoji('🎬').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`alerts:videotest:${selected.id}`).setLabel('Test video alert').setEmoji('🧪').setStyle(ButtonStyle.Secondary),
    ));
  }
  return { embeds: [embed], components, flags: EPHEMERAL, allowedMentions: { parse: [] } };
}
export async function handleCommand(i, store, platforms, monitor) {
  guard(i);
  const type = i.options.getSubcommand();
  if (type === 'add') {
    await i.deferReply({ flags: EPHEMERAL });
    if (store.list(i.guildId).length >= 25) throw new Error('Limit: 25 subscriptions per Discord server.');
    const platform = i.options.getString('platform', true);
    if (!platforms.configured(platform)) throw new Error(`${platform.toUpperCase()} is not configured on hosting. See README environment variables.`);
    const channel = i.options.getChannel('channel', true);
    ensureChannel(channel, i.guild);
    let creator = parseCreator(platform, i.options.getString('creator', true));
    if (platform === 'youtube') creator = await platforms.resolveYoutube(creator);
    const matches = store.list(i.guildId).find(x => x.platform === platform && (x.channelId || x.username) === (creator.channelId || creator.username) && x.destinationId === channel.id);
    if (matches) throw new Error(`Already tracking this creator in that destination: ${matches.id}`);
    const mode = supportsVideoUploads(platform) ? (i.options.getString('notify') || 'both') : 'streams';
    const obj = { id: randomUUID().slice(0, 8), guildId: i.guildId, platform, username: creator.username,
      channelId: creator.channelId || null, uploadsPlaylistId: creator.uploadsPlaylistId || null, profileUrl: creator.profileUrl, mode,
      displayName: i.options.getString('display_name') || creator.username,
      destinationId: channel.id, template: DEFAULT_TEMPLATE, videoTemplate: DEFAULT_VIDEO_TEMPLATE,
      pingMode: 'none', roleId: null, videoPingMode: 'none', videoRoleId: null,
      uploadsInitialized: false, seenUploadIds: [],
      initialized: false, wasLive: false, lastStreamId: null, offlineChecks: 0, lastStatus: 'Pending',
      createdAt: new Date().toISOString() };
    store.add(obj);
    return i.editReply(`✅ Tracking **${obj.displayName}** on **${platform}** (${mode}) in ${channel}.\nID: ${linkId(obj.id)}\nUse \`/alerts ping\` to enable @everyone or role pings and \`/alerts message\` to customize text.\n**First check records a baseline; it won't ping for an already-running stream.**`);
  }
  if (type === 'list') {
    const items = store.list(i.guildId);
    if (!items.length) return i.reply(reply('No subscriptions yet. Start with `/alerts add`.'));
    return i.reply(reply(items.map(x => `${linkId(x.id)} — **${x.displayName}** (${x.platform}) → <#${x.destinationId}> · ${x.lastStatus || 'Pending'} · ${normalizeUploadMode(x.platform, x.mode)}${x.lastError ? ' ⚠️' : ''}`).join('\n').slice(0, 1900)));
  }
  if (type === 'status') {
    const items = store.list(i.guildId);
    const cfg = ['twitch', 'kick', 'youtube', 'tiktok'].map(p => `${platforms.configured(p) ? '✅' : '❌'} ${p}`).join(' | ');
    return i.reply(reply(`**Monitor:** every ${Math.round(monitor.interval / 1000)}s\n**Linked:** ${items.length}\n**APIs:** ${cfg}\n${items.filter(x => x.lastError).slice(0, 5).map(x => `⚠️ ${x.username}: ${x.lastError}`).join('\n') || 'No recorded errors.'}`));
  }
  if (type === 'panel') return i.reply(panel(store, i.guildId));
  const item = getSub(i, store, i.options.getString('id', true));
  if (type === 'type') {
    if (!supportsVideoUploads(item.platform)) throw new Error('Video uploads are supported for YouTube and TikTok subscriptions only.');
    const mode = i.options.getString('notify', true);
    const oldMode = normalizeUploadMode(item.platform, item.mode);
    const wasVideoEnabled = oldMode !== 'streams';
    const nowVideoEnabled = mode !== 'streams';
    store.patch(i.guildId, item.id, { mode,
      ...(nowVideoEnabled && !wasVideoEnabled ? { uploadsInitialized: false, seenUploadIds: [] } : {}) });
    return i.reply(reply(`✅ Now tracking **${mode}** for ${item.displayName}. Newly enabled video alerts start by recording existing uploads without announcing old videos.`));
  }
  if (type === 'video_message') {
    if (!supportsVideoUploads(item.platform)) throw new Error('This command is for YouTube and TikTok creators.');
    store.patch(i.guildId, item.id, { videoTemplate: i.options.getString('text', true) });
    return i.reply(reply('✅ Video announcement text updated. Use `/alerts test kind:video` to preview it.'));
  }
  if (type === 'message') {
    const text = i.options.getString('text', true);
    store.patch(i.guildId, item.id, { template: text });
    return i.reply(reply(`✅ Template saved. Preview (ping not sent):\n${renderTemplate(text, { creator: item.displayName, title: 'Stream title', url: item.profileUrl, platform: item.platform }, item.pingMode, item.roleId).slice(0, 1500)}`));
  }
  if (type === 'ping' || type === 'video_ping') {
    const video = type === 'video_ping';
    if (video && !supportsVideoUploads(item.platform)) throw new Error('Video pings are only available for YouTube and TikTok creators.');
    const mode = i.options.getString('mode', true);
    const role = i.options.getRole('role');
    if (mode === 'role' && !role) throw new Error('Choose a role when using role ping.');
    if (mode !== 'role' && role) throw new Error('Only select a role with role ping mode.');
    store.patch(i.guildId, item.id, video
      ? { videoPingMode: mode, videoRoleId: mode === 'role' ? role.id : null }
      : { pingMode: mode, roleId: mode === 'role' ? role.id : null });
    return i.reply(reply(`✅ ${video ? 'Video' : 'Stream'} ping updated to **${mode}**${role ? ` <@&${role.id}>` : ''}. Place \`{ping}\` in the template to display the ping.`));
  }
  if (type === 'channel') {
    const channel = i.options.getChannel('channel', true);
    ensureChannel(channel, i.guild);
    store.patch(i.guildId, item.id, { destinationId: channel.id });
    return i.reply(reply(`✅ ${item.displayName} notifications now go to ${channel}.`));
  }
  if (type === 'remove') {
    store.remove(i.guildId, item.id);
    return i.reply(reply(`🗑️ Removed ${item.displayName}.`));
  }
  if (type === 'test') {
    await i.deferReply({ flags: EPHEMERAL });
    const kind = i.options.getString('kind') || 'stream';
    if (kind === 'video' && !supportsVideoUploads(item.platform)) throw new Error('Video tests require a YouTube or TikTok creator.');
    await monitor.sendTest(item, kind);
    return i.editReply(`✅ Sent a test notification to <#${item.destinationId}>. **It may ping** according to your chosen ping mode.`);
  }
  if (type === 'check') {
    await i.deferReply({ flags: EPHEMERAL });
    const kind = i.options.getString('kind') || 'stream';
    if (kind === 'video') {
      if (!supportsVideoUploads(item.platform)) throw new Error('Video checks are available for YouTube and TikTok subscriptions only.');
      const info = await platforms.uploads(item);
      return i.editReply(info.videos?.length
        ? `🎬 **Latest public videos:**\n${info.videos.slice(0, 5).map(v => `${v.title}: ${v.url}`).join('\n')}`
        : 'No public video uploads were found in the recent list.');
    }
    const info = await platforms.check(item);
    return i.editReply(info.live ? `🔴 **LIVE:** ${info.creator} — ${info.title}\n${info.url}` : `⚫ **OFFLINE:** ${item.displayName}`);
  }
}

export async function handleComponents(i, store, monitor) {
  if (!i.customId?.startsWith('alerts:')) return false;
  guard(i);
  if (i.isStringSelectMenu() && i.customId === 'alerts:select') {
    const { flags, ...message } = panel(store, i.guildId, i.values[0]);
    return i.update(message);
  }
  const [prefix, action, id] = i.customId.split(':');
  const item = getSub(i, store, id);
  if ((action === 'edit' || action === 'videoedit') && i.isButton()) {
    const video = action === 'videoedit';
    if (video && !supportsVideoUploads(item.platform)) throw new Error('Video announcements require a YouTube or TikTok subscription.');
    const field = new TextInputBuilder().setCustomId('template').setLabel('Message ({creator}, {title}, {ping})')
      .setStyle(TextInputStyle.Paragraph).setMinLength(1).setMaxLength(1800).setRequired(true).setValue(video ? (item.videoTemplate || DEFAULT_VIDEO_TEMPLATE) : (item.template || DEFAULT_TEMPLATE));
    const modal = new ModalBuilder().setCustomId(`alerts:${video ? 'videosave' : 'save'}:${id}`).setTitle(video ? 'Edit Video Upload Message' : 'Edit Stream Alert Message')
      .addComponents(new ActionRowBuilder().addComponents(field));
    await i.showModal(modal); return true;
  }
  if ((action === 'save' || action === 'videosave') && i.isModalSubmit()) {
    store.patch(i.guildId, id, action === 'videosave'
      ? { videoTemplate: i.fields.getTextInputValue('template') }
      : { template: i.fields.getTextInputValue('template') });
    await i.reply(reply('✅ Message updated. Use **Test alert** to preview.')); return true;
  }
  if (action === 'ping' && i.isButton()) {
    const rows = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
      .setCustomId(`alerts:pingselect:${id}`).setPlaceholder('Choose ping mode')
      .addOptions(modeChoices.map(c => ({ label: c.value, value: c.value, default: item.pingMode === c.value }))));
    await i.reply({ content: 'Select a ping mode. For a **role** ping, use `/alerts ping` with the role option.', components: [rows], flags: EPHEMERAL }); return true;
  }
  if (action === 'pingselect' && i.isStringSelectMenu()) {
    const mode = i.values[0];
    if (mode === 'role' && !item.roleId) return i.update({ content: 'To ping a role, use `/alerts ping id:<id> mode:role role:@Role`.', components: [] });
    store.patch(i.guildId, id, { pingMode: mode });
    await i.update({ content: `✅ Ping set to **${mode}**.`, components: [] }); return true;
  }
  if ((action === 'test' || action === 'videotest') && i.isButton()) {
    await i.deferReply({ flags: EPHEMERAL });
    await monitor.sendTest(item, action === 'videotest' ? 'video' : 'stream');
    await i.editReply('✅ Test alert sent.'); return true;
  }
  if (action === 'refresh' && i.isButton()) {
    const { flags, ...message } = panel(store, i.guildId, id);
    await i.update(message); return true;
  }
  return false;
}
