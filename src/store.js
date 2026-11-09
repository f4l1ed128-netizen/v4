import fs from 'node:fs';
import path from 'node:path';

function readSubscriptions(file) {
  const loaded = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(loaded?.subscriptions)) throw new Error('Invalid alerts.json: subscriptions missing');
  return loaded.subscriptions;
}

export class Store {
  constructor(directory = './data') {
    this.file = path.join(directory, 'alerts.json');
    this.backup = `${this.file}.bak`;
    fs.mkdirSync(directory, { recursive: true });
    this.data = { version: 1, subscriptions: [] };
    if (fs.existsSync(this.file)) this.recover();
  }
  // Load alerts.json. If it is corrupt, use the last good backup. If there is no
  // usable backup, keep the damaged file aside (never deleted) and start empty
  // instead of crashing the bot on every restart.
  recover() {
    try {
      this.data = { version: 1, subscriptions: readSubscriptions(this.file) };
      return;
    } catch (primary) {
      console.error(`[STORE] alerts.json is unreadable (${primary.message}).`);
      const quarantine = `${this.file}.corrupt-${Date.now()}`;
      try { fs.renameSync(this.file, quarantine); console.error(`[STORE] Damaged file kept as ${quarantine}`); }
      catch (e) { console.error('[STORE] Could not move damaged file:', e.message); }
      if (fs.existsSync(this.backup)) {
        try {
          this.data = { version: 1, subscriptions: readSubscriptions(this.backup) };
          console.error(`[STORE] Restored ${this.data.subscriptions.length} subscription(s) from alerts.json.bak`);
          this.save();
          return;
        } catch (e) { console.error(`[STORE] Backup is also unreadable (${e.message}).`); }
      }
      console.error('[STORE] Starting with no subscriptions. Re-add creators with /alerts add, or restore data/alerts.json manually.');
    }
  }
  save() {
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    // Keep the previous good version as a backup before replacing it.
    if (fs.existsSync(this.file)) {
      try { fs.copyFileSync(this.file, this.backup); } catch (e) { console.error('[STORE] Backup failed:', e.message); }
    }
    fs.renameSync(temp, this.file);
  }
  list(guildId) { return this.data.subscriptions.filter(s => !guildId || s.guildId === guildId); }
  find(guildId, id) { return this.list(guildId).find(s => s.id === id); }
  add(value) { this.data.subscriptions.push(value); this.save(); return value; }
  patch(guildId, id, changes) {
    const item = this.find(guildId, id);
    if (!item) return null;
    Object.assign(item, changes);
    this.save();
    return item;
  }
  remove(guildId, id) {
    const old = this.data.subscriptions.length;
    this.data.subscriptions = this.data.subscriptions.filter(s => !(s.guildId === guildId && s.id === id));
    if (old === this.data.subscriptions.length) return false;
    this.save(); return true;
  }
}
