import { ChannelType, PermissionFlagsBits } from 'discord.js';
import { dashboard } from './ui.js';
import { isOwnerPresent, cleanRoomName } from './utils.js';
import { hasHumanVoiceMembers, isTempVoicePanel, preferredPanel } from './housekeeping.js';

const OWNER_PERMISSIONS = {
  ViewChannel: true, Connect: true, SendMessages: true, ReadMessageHistory: true,
};
const BOT_PERMISSIONS = {
  ViewChannel: true, Connect: true, SendMessages: true, AttachFiles: true, EmbedLinks: true,
  ReadMessageHistory: true, ManageChannels: true, MoveMembers: true, MuteMembers: true,
};

export class RoomManager {
  constructor(client, store, graceMs = 15000) {
    this.client = client;
    this.store = store;
    this.graceMs = graceMs;
    this.timers = new Map();
    this.panelTimers = new Map();
    this.panelJobs = new Map(); // serialize dashboard creation and edits per channel
    this.sweepTimer = null;
    this.creating = new Set();
    this.roomLocks = new Map();
  }

  async setup(guild, hubChoice, categoryChoice) {
    const me = await guild.members.fetchMe();
    if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
      throw new Error('I need **Manage Channels** to create temporary rooms.');
    }
    if (!me.permissions.has(PermissionFlagsBits.MoveMembers)) {
      throw new Error('I need **Move Members** to move people into their new rooms.');
    }
    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
      throw new Error('I need **Manage Roles** for room permission overwrites.');
    }

    const saved = this.store.config(guild.id);
    let hub = hubChoice || (saved?.hubId ? await guild.channels.fetch(saved.hubId).catch(() => null) : null);
    let category = categoryChoice || (saved?.categoryId ? await guild.channels.fetch(saved.categoryId).catch(() => null) : null);
    if (!category && hub?.parentId) category = await guild.channels.fetch(hub.parentId).catch(() => null);
    if (category && category.type !== ChannelType.GuildCategory) throw new Error('Choose a category channel.');
    if (!category) category = await guild.channels.create({ name: 'الرومات المؤقتة', type: ChannelType.GuildCategory, reason: 'TempVoice setup' });
    if (!hub) hub = await guild.channels.create({
      name: '➕・إنشاء روم', type: ChannelType.GuildVoice, parent: category.id,
      reason: 'TempVoice join-to-create hub',
    });
    if (hub.type !== ChannelType.GuildVoice) throw new Error('Choose a normal voice channel as the hub.');
    this.store.setConfig(guild.id, { hubId: hub.id, categoryId: category.id });
    return { hub, category };
  }

  async onVoiceState(oldState, newState) {
    const guild = newState.guild;
    if (oldState.channelId === newState.channelId) return;
    // Event handlers must never block each other or crash the gateway listener.
    if (oldState.channelId && this.store.room(oldState.channelId)) {
      const previous = this.store.room(oldState.channelId);
      // A room-owner server mute must not follow a member into unrelated channels.
      if ((previous.mutedMembers || []).includes(oldState.id)) {
        this.store.patchRoom(oldState.channelId, {
          mutedMembers: previous.mutedMembers.filter(id => id !== oldState.id),
        });
        const member = newState.member || oldState.member;
        if (member?.voice.serverMute) {
          member.voice.setMute(false, 'TempVoice room mute cleared on exit')
            .catch(error => console.warn('[TempVoice] Could not clear room mute:', error));
        }
      }
      this.scheduleCleanup(oldState.channelId);
    }
    if (newState.channelId && this.store.room(newState.channelId)) {
      this.cancelCleanup(newState.channelId);
    }
    const config = this.store.config(guild.id);
    if (!config || newState.channelId !== config.hubId || newState.member?.user.bot) return;
    const user = newState.member;
    if (!user) return;
    const key = `${guild.id}:${user.id}`;
    if (this.creating.has(key)) return;
    this.creating.add(key);
    try { await this.createFor(user, config); }
    catch (err) { console.error(`[TempVoice] Failed to create room for ${user.id}:`, err); }
    finally { this.creating.delete(key); }
  }

  async createFor(member, config) {
    const guild = member.guild;
    if (member.voice.channelId !== config.hubId) return;
    const current = this.store.roomOwnedBy(guild.id, member.id);
    if (current) {
      const existing = await guild.channels.fetch(current[0]).catch(() => null);
      if (existing?.type === ChannelType.GuildVoice) {
        this.cancelCleanup(existing.id);
        try { await member.voice.setChannel(existing, 'Reconnect to personal room'); }
        catch (e) { console.error(`[TempVoice] Unable to move user to existing room:`, e); }
        return;
      }
      this.store.deleteRoom(current[0]);
    }

    const category = await guild.channels.fetch(config.categoryId).catch(() => null);
    if (!category || category.type !== ChannelType.GuildCategory) {
      throw new Error('Configured category no longer exists; run /setup again.');
    }
    // Copy category overwrites, then add the owner and bot overrides.
    // This preserves category permissions instead of unintentionally clearing them.
    const permissions = category.permissionOverwrites.cache.map(o => ({
      id: o.id, type: o.type, allow: o.allow.bitfield, deny: o.deny.bitfield,
    }));
    const upsert = (id, rules) => {
      const old = permissions.find(p => p.id === id);
      if (old) permissions.splice(permissions.indexOf(old), 1);
      // Permission overwrites accept a map; apply only explicit requested permissions.
      const allow = Object.entries(rules).reduce((bits, [key, enabled]) =>
        enabled ? bits | PermissionFlagsBits[key] : bits, 0n);
      permissions.push({ id, type: 1, allow, deny: 0n });
    };
    // Explicit owner/bot grants override category rules for those two specific members.
    upsert(this.client.user.id, BOT_PERMISSIONS);
    upsert(member.id, OWNER_PERMISSIONS);

    const voice = await guild.channels.create({
      name: `🔊・${cleanRoomName(member.displayName) || 'رومي'}`.slice(0, 90),
      type: ChannelType.GuildVoice,
      parent: category.id,
      permissionOverwrites: permissions,
      reason: `Temporary room created by ${member.user.tag}`,
    });
    const room = {
      guildId: guild.id, ownerId: member.id, createdAt: Date.now(),
      panelMessageId: null, locked: false, hidden: false, mutedMembers: [],
    };
    this.store.setRoom(voice.id, room);
    try {
      if (member.voice.channelId !== config.hubId) throw new Error('Member left the create hub before move.');
      await member.voice.setChannel(voice, 'Move into newly created TempVoice room');
    } catch (err) {
      this.store.deleteRoom(voice.id);
      await voice.delete('Creation failed or member left the hub').catch(() => {});
      throw err;
    }
    await this.refreshPanel(voice.id);
  }

  // The same join can trigger several events before the panel has been saved.
  // Only ONE send/edit is allowed per room at a time.
  async refreshPanel(channelId) {
    if (this.panelJobs.has(channelId)) return this.panelJobs.get(channelId);
    const job = this._refreshPanelOnce(channelId);
    this.panelJobs.set(channelId, job);
    try { return await job; }
    finally {
      if (this.panelJobs.get(channelId) === job) this.panelJobs.delete(channelId);
    }
  }

  isManagedPanel(message, channelId) {
    return isTempVoicePanel(message, channelId, this.client.user?.id);
  }

  async _refreshPanelOnce(channelId) {
    const room = this.store.room(channelId);
    if (!room) return;
    const guild = this.client.guilds.cache.get(room.guildId);
    const channel = await guild?.channels.fetch(channelId).catch(() => null);
    if (!channel || channel.type !== ChannelType.GuildVoice) return;

    // Recover existing panels created before a crash or by the previous release.
    // In particular, remove the duplicate panels created by V3's race condition.
    let candidates = [];
    try {
      const recent = await channel.messages.fetch({ limit: 100 });
      candidates = [...recent.values()].filter(message => this.isManagedPanel(message, channelId));
    } catch (error) {
      console.warn(`[TEMPO] Cannot scan old panel messages for ${channelId}: ${error.message}`);
    }
    let current = preferredPanel(candidates, room.panelMessageId);
    if (!current && room.panelMessageId) {
      current = await channel.messages.fetch(room.panelMessageId).catch(() => null);
      if (current && !this.isManagedPanel(current, channelId)) current = null;
    }
    if (current) {
      if (this.store.room(channelId)?.panelMessageId !== current.id) {
        this.store.patchRoom(channelId, { panelMessageId: current.id });
      }
      for (const duplicate of candidates) {
        if (duplicate.id === current.id) continue;
        await duplicate.delete().catch(error =>
          console.warn(`[TEMPO] Could not remove duplicate panel ${duplicate.id}: ${error.message}`));
      }
      try {
        await current.edit({ ...dashboard(channel, room), attachments: [] });
      } catch (error) {
        // Never send a second panel just because an edit failed.
        console.warn(`[TEMPO] Could not update panel ${current.id}: ${error.message}`);
      }
      return;
    }

    // Recheck the store, as the temporary room could have been removed meanwhile.
    if (!this.store.room(channelId)) return;
    try {
      const sent = await channel.send(dashboard(channel, room));
      if (this.store.room(channelId)) this.store.patchRoom(channelId, { panelMessageId: sent.id });
      else await sent.delete().catch(() => {});
    } catch (error) {
      console.warn(`[TEMPO] Cannot post dashboard in ${channelId}: ${error.message}`);
    }
  }

  schedulePanelUpdate(channelId) {
    if (this.panelTimers.has(channelId)) return;
    const timer = setTimeout(() => {
      this.panelTimers.delete(channelId);
      this.refreshPanel(channelId).catch(console.error);
    }, 900);
    timer.unref?.();
    this.panelTimers.set(channelId, timer);
  }
  cancelCleanup(id) {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
  }
  scheduleCleanup(id) {
    if (this.timers.has(id)) return;
    const timer = setTimeout(() => {
      this.timers.delete(id);
      this.cleanupRoom(id).catch(console.error);
    }, this.graceMs);
    timer.unref?.();
    this.timers.set(id, timer);
  }
  // Use the gateway's voice-state cache rather than the channel.members collection,
  // which can lag behind a disconnect on some hosts. Bots do not keep a room alive.
  hasHumanOccupants(channel) {
    return hasHumanVoiceMembers(channel);
  }

  async cleanupRoom(id) {
    return this.withRoomLock(id, async () => {
      const room = this.store.room(id);
      if (!room) return;
      const guild = this.client.guilds.cache.get(room.guildId);
      if (!guild) return; // Don't erase state while the guild is unavailable.
      const channel = await guild.channels.fetch(id).catch(() => null);
      if (!channel) { this.forgetRoom(id); return; }
      if (this.hasHumanOccupants(channel)) return;
      try { await channel.delete('TEMPO: empty temporary voice room'); }
      catch (error) {
        console.error(`[TEMPO] Could not delete empty room ${id}: ${error.message}`);
        return;
      }
      this.forgetRoom(id);
    });
  }

  // A missed voice-leave event should never leave ghost rooms forever.
  async sweepEmptyRooms() {
    for (const [id, room] of Object.entries(this.store.data.rooms)) {
      const guild = this.client.guilds.cache.get(room.guildId);
      if (!guild) continue;
      const channel = await guild.channels.fetch(id).catch(() => null);
      if (!channel) { this.forgetRoom(id); continue; }
      if (this.hasHumanOccupants(channel)) this.cancelCleanup(id);
      else this.scheduleCleanup(id);
    }
  }

  startCleanupSweep() {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      this.sweepEmptyRooms().catch(error => console.error('[TEMPO] cleanup sweep:', error));
    }, 30000);
    this.sweepTimer.unref?.();
  }

  async withRoomLock(id, fn) {
    const previous = this.roomLocks.get(id) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    this.roomLocks.set(id, current);
    await previous;
    try { return await fn(); }
    finally {
      release();
      if (this.roomLocks.get(id) === current) this.roomLocks.delete(id);
    }
  }

  async transfer(channel, room, targetMember) {
    if (room.ownerId === targetMember.id) throw new Error('This person is already the owner.');
    if (targetMember.voice.channelId !== channel.id) throw new Error('The new owner must be connected to this voice room.');
    if (targetMember.user.bot) throw new Error('Bots cannot own rooms.');
    await channel.permissionOverwrites.edit(targetMember.id, OWNER_PERMISSIONS, { reason: 'TempVoice ownership transfer' });
    await channel.permissionOverwrites.delete(room.ownerId, 'TempVoice previous owner privileges removed').catch(err => {
      console.warn('Unable to revoke old owner overwrite:', err);
    });
    this.store.patchRoom(channel.id, { ownerId: targetMember.id });
    this.schedulePanelUpdate(channel.id);
  }

  async recover() {
    for (const [id, room] of Object.entries(this.store.data.rooms)) {
      const guild = this.client.guilds.cache.get(room.guildId);
      if (!guild) continue;
      const channel = await guild.channels.fetch(id).catch(() => null);
      if (!channel || channel.type !== ChannelType.GuildVoice) {
        this.store.deleteRoom(id);
        continue;
      }
      if (!this.hasHumanOccupants(channel)) this.scheduleCleanup(id);
      this.schedulePanelUpdate(id);
    }
  }

  async deleteRoom(channelId, reason = 'TempVoice owner deleted room') {
    const room = this.store.room(channelId);
    if (!room) return;
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (channel) {
      // Remove server mutes applied by this room before disconnecting its users.
      for (const id of room.mutedMembers || []) {
        const member = await channel.guild.members.fetch(id).catch(() => null);
        if (member?.voice.serverMute) await member.voice.setMute(false, 'TempVoice room deleted').catch(console.error);
      }
      await channel.delete(reason);
    }
    this.forgetRoom(channelId);
  }
  forgetRoom(channelId) {
    this.cancelCleanup(channelId);
    const timer = this.panelTimers.get(channelId);
    if (timer) clearTimeout(timer);
    this.panelTimers.delete(channelId);
    this.store.deleteRoom(channelId);
  }
  ownerPresent(channel, room) { return isOwnerPresent(room, [...channel.members.values()]); }
}
