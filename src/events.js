/** Creator Live Alerts V5 event receiver.
 * Incoming endpoints need an HTTPS public reverse proxy (PUBLIC_BASE_URL).
 * Raw payload checks MUST happen before any Discord message is queued.
 */
import http from 'node:http';
import { createHmac, createVerify, timingSafeEqual } from 'node:crypto';
import { normalizeUploadMode } from './uploads.js';

const HUB = 'https://pubsubhubbub.appspot.com/subscribe';
const KICK_KEY_URL = 'https://api.kick.com/public/v1/public-key';
const DAY = 86_400_000;

function matchesKey(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && timingSafeEqual(x, y);
}
function validTime(value, skewMs = 600_000) {
  const time = Date.parse(String(value || ''));
  return Number.isFinite(time) && Math.abs(Date.now() - time) <= skewMs;
}
function send(res, status, body = '') {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
export function parseYoutubeFeed(xml) {
  const text = String(xml || '');
  const channelId = /<yt:channelId>\s*([^<]+)\s*<\/yt:channelId>/i.exec(text)?.[1];
  const entries = [...text.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi)];
  return entries.map(([, entry]) => ({
    channelId: /<yt:channelId>\s*([^<]+)\s*<\/yt:channelId>/i.exec(entry)?.[1] || channelId,
    videoId: /<yt:videoId>\s*([^<]+)\s*<\/yt:videoId>/i.exec(entry)?.[1],
  })).filter(x => /^UC[\w-]{22}$/.test(x.channelId || '') && /^[\w-]{11}$/.test(x.videoId || ''));
}
export function verifyTwitch(headers, raw, secret) {
  if (!secret || !validTime(headers['twitch-eventsub-message-timestamp'])) return false;
  const msg = String(headers['twitch-eventsub-message-id'] || '') + String(headers['twitch-eventsub-message-timestamp'] || '') + raw;
  const signature = `sha256=${createHmac('sha256', secret).update(msg).digest('hex')}`;
  return matchesKey(signature, headers['twitch-eventsub-message-signature']);
}
export function verifyKick(headers, raw, key) {
  if (!key || !validTime(headers['kick-event-message-timestamp'])) return false;
  const signature = headers['kick-event-signature'];
  if (!signature || !headers['kick-event-message-id']) return false;
  try {
    const message = `${headers['kick-event-message-id']}.${headers['kick-event-message-timestamp']}.${raw}`;
    return createVerify('RSA-SHA256').update(message).end().verify(key, String(signature), 'base64');
  } catch { return false; }
}
async function readPayload(request) {
  let bytes = 0, chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 256_000) throw new Error('Webhook payload too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
async function safeFetchJson(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body).slice(0, 180)}`);
  return body;
}
function streamSubs(store, platform) {
  return store.list().filter(s => s.platform === platform && normalizeUploadMode(s.platform, s.mode) !== 'videos');
}
export class EventBridge {
  constructor(monitor, platforms, store, options = {}) {
    this.monitor = monitor;
    this.platforms = platforms;
    this.store = store;
    this.env = options.env || process.env;
    this.base = String(this.env.PUBLIC_BASE_URL || '').trim().replace(/\/$/, '');
    this.enabled = /^https:\/\/[^/]+$/i.test(this.base);
    this.port = Math.max(1, Number(this.env.PORT || 3000));
    this.server = null;
    this.timer = null;
    this.syncRunning = false;
    this.hubRenew = new Map();
    this.kickCreated = new Map();
    this.kickKey = null;
    this.kickKeyExpiry = 0;
    this.kickKeyTask = null;
  }
  async start() {
    // Listen locally even without a public URL for provider readiness/health checks.
    this.server = http.createServer((req, res) => this.receive(req, res).catch(err => {
      console.error('[EVENTS] webhook error:', err.message);
      if (!res.headersSent) send(res, 500, 'internal error');
    }));
    await new Promise((resolve, reject) => this.server.once('error', reject).listen(this.port, '0.0.0.0', resolve));
    console.log(`[EVENTS] Receiver listening on PORT=${this.port}. Public HTTPS: ${this.enabled ? this.base : 'NOT CONFIGURED (polling only)'}`);
    if (this.enabled) {
      void this.sync().catch(e => console.error('[EVENTS] Initial subscription sync:', e.message));
      this.timer = setInterval(() => void this.sync().catch(e => console.error('[EVENTS] sync:', e.message)), 15 * 60_000);
      this.timer.unref?.();
    }
  }
  stop() { if (this.timer) clearInterval(this.timer); this.server?.close(); }
  async receive(req, res) {
    const path = new URL(req.url || '/', 'http://localhost');
    if (path.pathname === '/health' && req.method === 'GET') return send(res, 200, 'creator-alerts online');
    if (!this.enabled) return send(res, 503, 'PUBLIC_BASE_URL is not configured');
    if (path.pathname === '/webhooks/youtube' && req.method === 'GET') {
      const mode = path.searchParams.get('hub.mode');
      const topic = path.searchParams.get('hub.topic') || '';
      const challenge = path.searchParams.get('hub.challenge') || '';
      const ch = /^https:\/\/www\.youtube\.com\/xml\/feeds\/videos\.xml\?channel_id=(UC[\w-]{22})$/.exec(topic);
      if (!['subscribe', 'unsubscribe'].includes(mode) || !ch || !challenge || challenge.length > 500 ||
          !this.store.list().some(x => x.platform === 'youtube' && x.channelId === ch[1])) return send(res, 404);
      return send(res, 200, challenge);
    }
    if (req.method !== 'POST') return send(res, 404);
    const raw = await readPayload(req);
    if (path.pathname === '/webhooks/youtube') return this.youtubeEvent(req, res, raw);
    if (path.pathname === '/webhooks/twitch') return this.twitchEvent(req, res, raw);
    if (path.pathname === '/webhooks/kick') return this.kickEvent(req, res, raw);
    return send(res, 404);
  }
  async youtubeEvent(req, res, raw) {
    // Google hub may include X-Hub-Signature (sha1=...) when a hub.secret is set.
    const signature = req.headers['x-hub-signature'];
    const secret = this.env.YOUTUBE_HUB_SECRET;
    if (!secret) return send(res, 503, 'YOUTUBE_HUB_SECRET missing');
    const expected = `sha1=${createHmac('sha1', secret).update(raw).digest('hex')}`;
    if (!signature || !matchesKey(expected, signature)) return send(res, 401);
    const entries = parseYoutubeFeed(raw);
    send(res, 204);
    for (const entry of entries) {
      void this.handleYoutubeEntry(entry).catch(e => console.error('[EVENTS] YouTube:', e.message));
    }
  }
  async handleYoutubeEntry(entry) {
    const subscribers = this.store.list().filter(s => s.platform === 'youtube' && s.channelId === entry.channelId);
    if (!subscribers.length) return;
    const key = this.env.YOUTUBE_API_KEY;
    if (!key) return;
    const p = new URLSearchParams({ part: 'snippet,liveStreamingDetails,status', id: entry.videoId, key });
    const video = (await safeFetchJson(`https://www.googleapis.com/youtube/v3/videos?${p}`)).items?.[0];
    if (!video || video.id !== entry.videoId || video.snippet?.channelId !== entry.channelId || video.status?.privacyStatus !== 'public') return;
    const isLive = video.snippet?.liveBroadcastContent === 'live' && Boolean(video.liveStreamingDetails?.actualStartTime);
    const isUpload = video.snippet?.liveBroadcastContent === 'none' && !video.liveStreamingDetails?.actualStartTime && !video.liveStreamingDetails?.scheduledStartTime;
    for (const s of subscribers) {
      const mode = normalizeUploadMode(s.platform, s.mode);
      if (isLive && mode !== 'videos') {
        await this.monitor.process(s, { live: true, id: video.id, creator: video.snippet.channelTitle || s.username,
          title: video.snippet.title || 'LIVE on YouTube', platform: 'YouTube', viewers: '?', url: `https://www.youtube.com/watch?v=${video.id}` });
      } else if (isUpload && mode !== 'streams') {
        // Do not announce an upload while this creator is known LIVE.
        const state = this.store.find(s.guildId, s.id);
        if (state?.lastStatus === 'LIVE') continue;
        await this.monitor.processUploads(s, { allIds: [video.id], videos: [{ id: video.id,
          creator: video.snippet.channelTitle || s.username, title: video.snippet.title || 'New video',
          publishedAt: video.snippet.publishedAt, platform: 'YouTube', viewers: '?',
          url: `https://www.youtube.com/watch?v=${video.id}` }] });
      }
    }
  }
  async twitchEvent(req, res, raw) {
    if (!verifyTwitch(req.headers, raw, this.env.TWITCH_WEBHOOK_SECRET)) return send(res, 401);
    let body; try { body = JSON.parse(raw); } catch { return send(res, 400); }
    const type = req.headers['twitch-eventsub-message-type'];
    if (type === 'webhook_callback_verification') return send(res, 200, String(body.challenge || ''));
    send(res, 204);
    if (type !== 'notification' || body.subscription?.type !== 'stream.online' || !body.event) return;
    void this.handleTwitchEvent(body.event).catch(e => console.error('[EVENTS] Twitch:', e.message));
  }
  async handleTwitchEvent(ev) {
    if (ev.type && ev.type !== 'live') return;
    const login = String(ev.broadcaster_user_login || '').toLowerCase();
    if (!login || !ev.id) return;
    const info = { live: true, id: String(ev.id), creator: ev.broadcaster_user_name || login,
      title: 'LIVE on Twitch', platform: 'Twitch', viewers: '?', url: `https://www.twitch.tv/${login}` };
    for (const sub of streamSubs(this.store, 'twitch').filter(x => x.username.toLowerCase() === login))
      await this.monitor.process(sub, info);
  }
  async kickPublicKey() {
    if (this.kickKey && this.kickKeyExpiry > Date.now()) return this.kickKey;
    if (this.kickKeyTask) return this.kickKeyTask;
    this.kickKeyTask = (async () => {
      const res = await fetch(KICK_KEY_URL, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`Could not load Kick public key (${res.status})`);
      const payload = await res.text();
      let key = payload;
      if (!payload.includes('BEGIN PUBLIC KEY')) {
        try { const data = JSON.parse(payload); key = data.data?.public_key || data.public_key || data.data?.key || ''; } catch { /* use text */ }
      }
      if (!String(key).includes('BEGIN PUBLIC KEY')) throw new Error('Unexpected Kick public key format');
      this.kickKey = key; this.kickKeyExpiry = Date.now() + 3_600_000;
      return key;
    })().finally(() => { this.kickKeyTask = null; });
    return this.kickKeyTask;
  }
  async kickEvent(req, res, raw) {
    let key;
    try { key = await this.kickPublicKey(); }
    catch { return send(res, 503, 'Kick verification unavailable'); }
    if (!verifyKick(req.headers, raw, key)) return send(res, 401);
    let body; try { body = JSON.parse(raw); } catch { return send(res, 400); }
    send(res, 204);
    if (req.headers['kick-event-type'] !== 'livestream.status.updated' || typeof body.is_live !== 'boolean') return;
    void this.handleKickEvent(body).catch(e => console.error('[EVENTS] Kick:', e.message));
  }
  async handleKickEvent(ev) {
    const login = String(ev.broadcaster?.channel_slug || ev.broadcaster?.username || '').toLowerCase();
    if (!login) return;
    for (const sub of streamSubs(this.store, 'kick').filter(x => x.username.toLowerCase() === login)) {
      const info = ev.is_live ? { live: true, id: String(ev.started_at && !Number.isNaN(Date.parse(ev.started_at)) ? new Date(ev.started_at).toISOString() : `kick:${login}`),
        creator: ev.broadcaster?.username || login, title: ev.title || 'LIVE on Kick', platform: 'Kick',
        viewers: '?', url: `https://kick.com/${login}` } : { live: false };
      await this.monitor.process(sub, info);
    }
  }
  async sync() {
    if (this.syncRunning || !this.enabled) return;
    this.syncRunning = true;
    try {
      // YouTube hub leases expire. Renew after 5 days or if new channel added.
      const channels = [...new Set(this.store.list().filter(s => s.platform === 'youtube' && s.channelId).map(s => s.channelId))];
      if (this.env.YOUTUBE_HUB_SECRET) for (const channelId of channels) {
        if ((this.hubRenew.get(channelId) || 0) > Date.now()) continue;
        try {
          await this.subscribeYoutube(channelId);
          this.hubRenew.set(channelId, Date.now() + 5 * DAY);
          console.log(`[EVENTS] Requested YouTube WebSub for ${channelId}`);
        } catch (e) { console.error(`[EVENTS] YouTube subscribe ${channelId}:`, e.message); }
      }
      if (this.env.TWITCH_CLIENT_ID && this.env.TWITCH_CLIENT_SECRET && this.env.TWITCH_WEBHOOK_SECRET)
        await this.syncTwitch().catch(e => console.error('[EVENTS] Twitch subscribe:', e.message));
      if (this.env.KICK_CLIENT_ID && this.env.KICK_CLIENT_SECRET)
        await this.syncKick().catch(e => console.error('[EVENTS] Kick subscribe:', e.message));
    } finally { this.syncRunning = false; }
  }
  async subscribeYoutube(channelId) {
    const p = new URLSearchParams({
      'hub.callback': `${this.base}/webhooks/youtube`, 'hub.mode': 'subscribe',
      'hub.topic': `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${channelId}`,
      'hub.verify': 'async', 'hub.secret': this.env.YOUTUBE_HUB_SECRET, 'hub.lease_seconds': '604800',
    });
    const res = await fetch(HUB, { method: 'POST', body: p, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`hub HTTP ${res.status}`);
  }
  async syncTwitch() {
    const wanted = [...new Set(streamSubs(this.store, 'twitch').map(x => x.username.toLowerCase()))];
    if (!wanted.length) return;
    const token = await this.platforms.tokens.get('twitch', this.env.TWITCH_CLIENT_ID, this.env.TWITCH_CLIENT_SECRET);
    const headers = { Authorization: `Bearer ${token}`, 'Client-Id': this.env.TWITCH_CLIENT_ID, 'Content-Type': 'application/json' };
    const existing = new Set();
    let cursor = '';
    do {
      const p = new URLSearchParams(); if (cursor) p.set('after', cursor);
      const json = await safeFetchJson(`https://api.twitch.tv/helix/eventsub/subscriptions?${p}`, { headers });
      for (const s of json.data || []) if (s.type === 'stream.online' && s.transport?.callback === `${this.base}/webhooks/twitch` && ['enabled', 'webhook_callback_verification_pending'].includes(s.status))
        existing.add(s.condition?.broadcaster_user_id);
      cursor = json.pagination?.cursor || '';
    } while (cursor);
    for (let i = 0; i < wanted.length; i += 100) {
      const params = new URLSearchParams(); for (const name of wanted.slice(i, i + 100)) params.append('login', name);
      const users = await safeFetchJson(`https://api.twitch.tv/helix/users?${params}`, { headers });
      for (const user of users.data || []) {
        if (existing.has(user.id)) continue;
        const body = { type: 'stream.online', version: '1', condition: { broadcaster_user_id: user.id },
          transport: { method: 'webhook', callback: `${this.base}/webhooks/twitch`, secret: this.env.TWITCH_WEBHOOK_SECRET } };
        try {
          await safeFetchJson('https://api.twitch.tv/helix/eventsub/subscriptions', { method: 'POST', headers, body: JSON.stringify(body) });
          existing.add(user.id);
          console.log(`[EVENTS] Twitch stream.online subscribed: ${user.login}`);
        } catch (e) { console.error(`[EVENTS] Twitch ${user.login}:`, e.message); }
      }
    }
  }
  async syncKick() {
    const wanted = [...new Set(streamSubs(this.store, 'kick').map(x => x.username.toLowerCase()))];
    if (!wanted.length) return;
    const token = await this.platforms.tokens.get('kick', this.env.KICK_CLIENT_ID, this.env.KICK_CLIENT_SECRET);
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' };
    for (const name of wanted) {
      if ((this.kickCreated.get(name) || 0) > Date.now()) continue;
      try {
        const p = new URLSearchParams({ slug: name });
        const json = await safeFetchJson(`https://api.kick.com/public/v1/channels?${p}`, { headers });
        const c = json.data?.[0];
        const id = Number(c?.broadcaster_user_id || c?.user_id || c?.broadcaster?.user_id);
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error('No broadcaster_user_id from channel API');
        const body = { broadcaster_user_id: id, method: 'webhook', events: [{ name: 'livestream.status.updated', version: 1 }] };
        // The callback URL itself MUST be enabled in the Kick Developer settings.
        const result = await safeFetchJson('https://api.kick.com/public/v1/events/subscriptions', { method: 'POST', headers, body: JSON.stringify(body) });
        const err = result.data?.[0]?.error || result.data?.error;
        if (err) throw new Error(JSON.stringify(err));
        // Some Kick GET responses don't include newly created subscriptions; avoid repeated paid/API calls each sync.
        this.kickCreated.set(name, Date.now() + DAY);
        console.log(`[EVENTS] Kick event subscription requested: ${name}`);
      } catch (e) { console.error(`[EVENTS] Kick subscribe ${name}:`, e.message); }
    }
  }
}
