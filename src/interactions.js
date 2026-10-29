import {
  ActionRowBuilder, ChannelType, EmbedBuilder, MessageFlags, ModalBuilder,
  PermissionFlagsBits, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { dashboard, userPicker, regionPicker, confirmDelete, COLOR } from './ui.js';
import { cleanRoomName, parseUserLimit } from './utils.js';

const EPHEMERAL = MessageFlags.Ephemeral;
const MEMBER_ACTIONS = new Set(['permit', 'block', 'kick', 'transfer', 'mute', 'unmute', 'invite']);
const RESPONSE = content => ({ content, flags: EPHEMERAL, allowedMentions: { parse: [] } });

const isStaff = i => !!i.memberPermissions?.has(PermissionFlagsBits.ManageChannels);
const isServerManager = i => !!i.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
const requireOwner = (i, room) => {
  if (room.ownerId !== i.user.id && !isStaff(i)) throw new Error('هذا الزر لصاحب الروم أو الإدارة فقط.');
};
function context(i, manager, id) {
  const room = manager.store.room(id);
  const channel = i.guild?.channels.cache.get(id);
  if (!room || room.guildId !== i.guildId || channel?.type !== ChannelType.GuildVoice) {
    throw new Error('الروم المؤقتة غير موجودة. ادخل روم الإنشاء لإنشاء روم جديد.');
  }
  return { room, channel };
}
function requireClaim(i, manager, channel, room) {
  if (i.member?.voice?.channelId !== channel.id) throw new Error('لازم تكون موجود داخل الروم عشان تستلمها.');
  if (room.ownerId === i.user.id) throw new Error('أنت مالك الروم بالفعل.');
  if (manager.ownerPresent(channel, room)) throw new Error('المالك الحالي موجود في الروم.');
  if (manager.store.roomOwnedBy(i.guildId, i.user.id)) throw new Error('أنت تمتلك روم مؤقتة أخرى.');
}
function makeModal(channelId, action, current = '') {
  const rename = action === 'rename';
  const input = new TextInputBuilder()
    .setCustomId('value')
    .setLabel(rename ? 'اسم الروم الجديد' : 'الحد الأقصى للأعضاء (0 = بدون حد)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(rename ? 80 : 2)
    .setPlaceholder(rename ? 'روم الشباب' : '0 - 99');
  if (current) input.setValue(current);
  return new ModalBuilder()
    .setCustomId(`tv:${channelId}:modal_${action}`)
    .setTitle(rename ? '🪧 تغيير اسم الروم' : '👥 تحديد عدد الأعضاء')
    .addComponents(new ActionRowBuilder().addComponents(input));
}

async function setup(i, manager) {
  if (!isServerManager(i)) throw new Error('تحتاج صلاحية إدارة السيرفر لتفعيل نظام الرومات.');
  await i.deferReply({ flags: EPHEMERAL });
  const { hub, category } = await manager.setup(i.guild,
    i.options.getChannel('hub'), i.options.getChannel('category'));
  await i.editReply({ embeds: [new EmbedBuilder().setColor(COLOR).setTitle('✅ تم تشغيل نظام الرومات المؤقتة')
    .setDescription(`ادخل ${hub} لإنشاء روم خاصة بك تلقائيًا.\nتظهر الرومات داخل تصنيف **${category.name}**.\nلوحة التحكم العربية موجودة في شات الروم الصوتي.`)
    .addFields({ name: '🗂️ إدارة الروم', value: 'افتح شات الروم للتحكم بالأزرار، أو استخدم الأمر `/panel`.' })] });
}

async function command(i, manager) {
  switch (i.commandName) {
    case 'setup': return setup(i, manager);
    case 'tempvoice': {
      const sub = i.options.getSubcommand();
      if (sub === 'disable') {
        if (!isServerManager(i)) throw new Error('تحتاج صلاحية إدارة السيرفر.');
        manager.store.deleteConfig(i.guildId);
        return i.reply(RESPONSE('✅ تم تعطيل إنشاء الرومات الجديدة. الرومات الحالية تُحذف عند فراغها.'));
      }
      const cfg = manager.store.config(i.guildId);
      return i.reply(RESPONSE(cfg
        ? `✅ **النظام شغال**\nروم الإنشاء: <#${cfg.hubId}>\nالتصنيف: <#${cfg.categoryId}>\nالرومات الحالية: ${manager.store.roomsForGuild(i.guildId).length}`
        : 'النظام غير مفعّل. استخدم `/setup` بصلاحية إدارة السيرفر.'));
    }
    case 'panel': {
      const id = i.member?.voice?.channelId;
      if (!id) throw new Error('ادخل رومك المؤقتة أولًا.');
      const { room, channel } = context(i, manager, id);
      return i.reply({ ...dashboard(channel, room), flags: EPHEMERAL });
    }
    case 'claim': {
      const id = i.member?.voice?.channelId;
      if (!id) throw new Error('ادخل الروم التي تريد استلامها أولًا.');
      const { room, channel } = context(i, manager, id);
      await i.deferReply({ flags: EPHEMERAL });
      await manager.withRoomLock(id, async () => {
        const current = manager.store.room(id);
        if (!current) throw new Error('الروم غير موجودة.');
        requireClaim(i, manager, channel, current);
        await manager.transfer(channel, current, i.member);
      });
      return i.editReply('👑 أصبحت مالك الروم!');
    }
  }
}

async function chooseMember(i, manager, channel, room, action) {
  requireOwner(i, room);
  const id = i.values?.[0];
  if (!id) throw new Error('اختر عضوًا واحدًا.');
  const member = await i.guild.members.fetch(id).catch(() => null);
  if (!member) throw new Error('العضو ليس موجودًا في السيرفر.');
  if (member.user.bot && ['transfer', 'block', 'kick', 'mute'].includes(action)) {
    throw new Error('لا يمكن تنفيذ هذا الإجراء على بوت.');
  }
  if (id === room.ownerId && ['block', 'kick', 'mute'].includes(action)) {
    throw new Error('لا يمكن تنفيذ هذا الإجراء على مالك الروم.');
  }
  if (member.permissions.has(PermissionFlagsBits.Administrator) && ['block', 'kick', 'mute'].includes(action)) {
    throw new Error('لا يمكن تنفيذ هذا الإجراء على أدمن السيرفر.');
  }
  switch (action) {
    case 'permit':
      await channel.permissionOverwrites.edit(id, { Connect: true, ViewChannel: true }, { reason: 'TempVoice member permitted' });
      return `✅ تمت إضافة سماح دخول للعضو <@${id}>.`;
    case 'block':
      await channel.permissionOverwrites.edit(id, { Connect: false, ViewChannel: false }, { reason: 'TempVoice member blocked' });
      if (member.voice.channelId === channel.id) {
        await member.voice.setChannel(null, 'TempVoice blocked member');
      }
      return `🚫 تم منع العضو <@${id}> من الروم.`;
    case 'kick':
      if (member.voice.channelId !== channel.id) throw new Error('هذا العضو غير موجود في الروم.');
      await member.voice.setChannel(null, 'TempVoice owner disconnected member');
      return `🔨 تم طرد العضو <@${id}>.`;
    case 'transfer':
      if (manager.store.roomOwnedBy(i.guildId, id)) throw new Error('هذا العضو يمتلك رومًا مؤقتة أخرى.');
      await manager.transfer(channel, room, member);
      return `👑 تم نقل ملكية الروم إلى <@${id}>.`;
    case 'mute': {
      if (member.voice.channelId !== channel.id) throw new Error('العضو غير موجود في الروم.');
      if (member.voice.serverMute && !(room.mutedMembers || []).includes(id)) {
        throw new Error('هذا العضو مكتوم من الإدارة أصلًا؛ لن أغيّر كتم الإدارة.');
      }
      await member.voice.setMute(true, 'TempVoice room owner mute');
      const muted = [...new Set([...(room.mutedMembers || []), id])];
      manager.store.patchRoom(channel.id, { mutedMembers: muted });
      return `🔕 تم عمل ميوت للعضو <@${id}>.`;
    }
    case 'unmute': {
      if (member.voice.channelId !== channel.id) throw new Error('العضو غير موجود في الروم.');
      if (!(room.mutedMembers || []).includes(id)) throw new Error('هذا العضو ليس مكتومًا عبر لوحة الروم.');
      await member.voice.setMute(false, 'TempVoice room owner unmute');
      manager.store.patchRoom(channel.id, { mutedMembers: room.mutedMembers.filter(x => x !== id) });
      return `🎤 تم فك الميوت عن <@${id}>.`;
    }
    case 'invite': {
      if (member.user.bot) throw new Error('اختر مستخدمًا بدل بوت.');
      if (id === i.user.id) throw new Error('أنت بالفعل تملك رابط الروم.');
      // Inviting also permits entry if the room is locked or hidden.
      await channel.permissionOverwrites.edit(id, { Connect: true, ViewChannel: true }, { reason: 'TempVoice private invite access' });
      const link = `https://discord.com/channels/${i.guildId}/${channel.id}`;
      try {
        await member.send(`🔗 **دعوة إلى روم صوتية خاصة!**\n<@${i.user.id}> دعاك إلى **${channel.name}** في **${i.guild.name}**.\n${link}`);
        return `🔗 تم إرسال دعوة للعضو <@${id}> بالخاص، مع السماح له بالدخول.`;
      } catch {
        return `⚠️ تم السماح للعضو <@${id}> بالدخول، لكن تعذّر إرسال رسالة خاصة له. شاركه الرابط بنفسك: ${link}`;
      }
    }
    default: throw new Error('الأمر غير معروف.');
  }
}

async function component(i, manager) {
  const parts = i.customId.split(':');
  if (parts.length !== 3 || parts[0] !== 'tv') return;
  const [_, id, action] = parts;
  const { room, channel } = context(i, manager, id);

  if (i.isModalSubmit()) {
    requireOwner(i, room);
    const input = i.fields.getTextInputValue('value');
    if (action === 'modal_rename') {
      const name = cleanRoomName(input);
      if (name.length < 2) throw new Error('اسم الروم لازم يكون حرفين على الأقل.');
      await i.deferReply({ flags: EPHEMERAL });
      await manager.withRoomLock(id, async () => {
        requireOwner(i, manager.store.room(id));
        await channel.setName(name, 'TempVoice name changed');
      });
      manager.schedulePanelUpdate(id);
      return i.editReply(`🪧 تم تغيير اسم الروم إلى **${name.replaceAll('*', '∗')}**.`);
    }
    if (action === 'modal_limit') {
      const value = parseUserLimit(input);
      if (value === null) throw new Error('اكتب رقمًا صحيحًا من 0 إلى 99. الصفر يعني بدون حد.');
      await i.deferReply({ flags: EPHEMERAL });
      await manager.withRoomLock(id, async () => {
        requireOwner(i, manager.store.room(id));
        await channel.setUserLimit(value, 'TempVoice member limit changed');
      });
      manager.schedulePanelUpdate(id);
      return i.editReply(`👥 تم تحديد عدد الأعضاء: **${value || 'بدون حد'}**.`);
    }
    throw new Error('النافذة غير معروفة.');
  }

  if (i.isUserSelectMenu()) {
    if (!action.startsWith('pick_') || !MEMBER_ACTIONS.has(action.slice(5))) throw new Error('خيار العضو غير معروف.');
    await i.deferReply({ flags: EPHEMERAL });
    const result = await manager.withRoomLock(id, async () => {
      const freshRoom = manager.store.room(id);
      if (!freshRoom) throw new Error('الروم لم تعد موجودة.');
      return chooseMember(i, manager, channel, freshRoom, action.slice(5));
    });
    manager.schedulePanelUpdate(id);
    return i.editReply({ content: result, components: [], allowedMentions: { parse: [] } });
  }

  if (i.isStringSelectMenu()) {
    if (action !== 'pick_region') throw new Error('خيار الريجن غير معروف.');
    requireOwner(i, room);
    const selected = i.values?.[0];
    const allowed = new Set(['auto', 'rotterdam', 'us-east', 'us-west', 'us-central', 'brazil', 'singapore', 'japan', 'india', 'hongkong', 'sydney', 'southafrica']);
    if (!allowed.has(selected)) throw new Error('اختر منطقة من القائمة.');
    await i.deferReply({ flags: EPHEMERAL });
    await manager.withRoomLock(id, async () => {
      requireOwner(i, manager.store.room(id));
      await channel.setRTCRegion(selected === 'auto' ? null : selected, 'TempVoice region changed');
    });
    manager.schedulePanelUpdate(id);
    return i.editReply({ content: `🌍 تم تغيير الريجن إلى **${selected === 'auto' ? 'تلقائي' : selected}**.`, components: [] });
  }

  if (!i.isButton()) return;
  requireOwner(i, room);
  if (['rename', 'limit'].includes(action)) {
    return i.showModal(makeModal(id, action, action === 'rename' ? channel.name : String(channel.userLimit)));
  }
  if (MEMBER_ACTIONS.has(action)) return i.reply({ ...userPicker(id, action), flags: EPHEMERAL });
  if (action === 'region') return i.reply({ ...regionPicker(id, channel.rtcRegion), flags: EPHEMERAL });
  if (action === 'delete') return i.reply({ ...confirmDelete(id), flags: EPHEMERAL });
  if (action === 'delete_no') return i.update({ content: '✅ تم الإلغاء، رومك موجودة.', components: [] });
  if (action === 'delete_yes') {
    await i.update({ content: '🗑️ جاري حذف الروم...', components: [] });
    return manager.withRoomLock(id, async () => {
      requireOwner(i, manager.store.room(id));
      await manager.deleteRoom(id);
    });
  }
  const toggles = {
    lock: ['locked', 'Connect', true, '🔇 تم قفل الروم.'],
    unlock: ['locked', 'Connect', false, '🔊 تم فتح الروم.'],
    hide: ['hidden', 'ViewChannel', true, '🙈 تم إخفاء الروم.'],
    reveal: ['hidden', 'ViewChannel', false, '👁️ تم إظهار الروم.'],
  };
  if (toggles[action]) {
    const [property, permission, desired, response] = toggles[action];
    await i.deferReply({ flags: EPHEMERAL });
    const changed = await manager.withRoomLock(id, async () => {
      const fresh = manager.store.room(id);
      if (!fresh) throw new Error('الروم لم تعد موجودة.');
      requireOwner(i, fresh);
      if (fresh[property] === desired) return false;
      await channel.permissionOverwrites.edit(channel.guild.roles.everyone, { [permission]: desired ? false : null },
        { reason: `TempVoice owner updated ${property}` });
      manager.store.patchRoom(id, { [property]: desired });
      return true;
    });
    manager.schedulePanelUpdate(id);
    return i.editReply(changed ? response : '✅ هذه الحالة مفعلة بالفعل.');
  }
  throw new Error('الزر غير معروف.');
}

export async function handleInteraction(i, manager) {
  if (!i.guild) return;
  try {
    if (i.isChatInputCommand()) return await command(i, manager);
    if ((i.isButton() || i.isUserSelectMenu() || i.isStringSelectMenu() || i.isModalSubmit()) && i.customId.startsWith('tv:')) {
      return await component(i, manager);
    }
  } catch (err) {
    console.error(`[TempVoice] ${i.guildId}/${i.user.id}:`, err);
    const message = `⚠️ ${err.message || 'حدث خطأ. راجع سجل البوت.'}`.slice(0, 1900);
    try {
      if (i.deferred) await i.editReply({ content: message, embeds: [], components: [] });
      else if (i.replied) await i.followUp(RESPONSE(message));
      else await i.reply(RESPONSE(message));
    } catch (replyError) { console.error('[TempVoice] Failed to reply:', replyError); }
  }
}
