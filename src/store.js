import fs from 'node:fs';
import path from 'node:path';

const EMPTY = () => ({ schema: 1, configs: {}, rooms: {} });

/** Single-process persistent JSON store; atomic rename protects against partial writes. */
export class StateStore {
  constructor(file) {
    this.file = path.resolve(file);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    this.data = EMPTY();
    if (fs.existsSync(this.file)) {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed.schema !== 1 || !parsed.configs || !parsed.rooms) {
        throw new Error('State file has an unsupported format; back it up before migrating.');
      }
      this.data = parsed;
    }
  }
  save() {
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
  config(guildId) { return this.data.configs[guildId] || null; }
  setConfig(guildId, config) { this.data.configs[guildId] = config; this.save(); }
  deleteConfig(guildId) { delete this.data.configs[guildId]; this.save(); }
  room(channelId) { return this.data.rooms[channelId] || null; }
  setRoom(channelId, room) { this.data.rooms[channelId] = room; this.save(); }
  patchRoom(channelId, patch) {
    const room = this.room(channelId);
    if (!room) return null;
    this.data.rooms[channelId] = { ...room, ...patch };
    this.save();
    return this.data.rooms[channelId];
  }
  deleteRoom(channelId) { if (this.room(channelId)) { delete this.data.rooms[channelId]; this.save(); } }
  roomsForGuild(guildId) { return Object.entries(this.data.rooms).filter(([, r]) => r.guildId === guildId); }
  roomOwnedBy(guildId, userId) {
    return this.roomsForGuild(guildId).find(([, r]) => r.ownerId === userId) || null;
  }
}
