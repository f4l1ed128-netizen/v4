/** Optional outbound Twitch EventSub WebSocket for hosts without incoming HTTPS.
 * Requires a USER token via scripts/twitch-device-auth.js, not the app token.
 * Other platforms continue normal scans when Twitch authorization is absent.
 */
import fs from 'node:fs';
import path from 'node:path';
import { normalizeUploadMode } from './uploads.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const BASE = 'https://api.twitch.tv/helix';

export class TwitchSocket {
  constructor(monitor, store, options = {}) {
    this.monitor = monitor;
    this.store = store;
    this.env = options.env || process.env;
    this.WebSocket = options.WebSocket || globalThis.WebSocket;
    this.tokenFile = path.join(this.env.DATA_DIR || './data', 'twitch-oauth.json');
    this.token = null;
    this.ws = null;
    this.stopped = false;
    this.retries = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.syncTimer = null;
    this.keepAlive = 60_000;
    this.lastMessage = 0;
    this.lastWanted = '';
  }
  readToken() {
    if (!fs.existsSync(this.tokenFile)) return null;
    try {
      const data = JSON.parse(fs.readFileSync(this.tokenFile, 'utf8'));
      if (typeof data.access_token === 'string' && typeof data.refresh_token === 'string') return data;
    } catch (e) { console.error('[TWITCH-WS] Token file error:', e.message); }
    return null;
  }
  writeToken(data) {
    fs.mkdirSync(path.dirname(this.tokenFile), { recursive: true });
    const file = `${this.tokenFile}.${process.pid}.tmp`;
    fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(file, this.tokenFile);
  }
  async refresh() {
    if (!this.token?.refresh_token || !this.env.TWITCH_CLIENT_ID || !this.env.TWITCH_CLIENT_SECRET) {
      throw new Error('Twitch user token cannot refresh. Re-authorize with npm run twitch:auth.');
    }
    const params = new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: this.token.refresh_token,
      client_id: this.env.TWITCH_CLIENT_ID, client_secret: this.env.TWITCH_CLIENT_SECRET,
    });
    const res = await fetch('https://id.twitch.tv/oauth2/token', {
      method: 'POST', body: params, signal: AbortSignal.timeout(15_000),
    });
    const result = await res.json().catch(() => ({}));
    if (!res.ok || !result.access_token) throw new Error(`Twitch OAuth refresh HTTP ${res.status}`);
    this.token = { access_token: result.access_token, refresh_token: result.refresh_token || this.token.refresh_token };
    this.writeToken(this.token);
    return this.token.access_token;
  }
  async api(url, init = {}, retry = true) {
    const go = async () => {
      const res = await fetch(url, {
        ...init, signal: AbortSignal.timeout(15_000),
        headers: {
          'Client-Id': this.env.TWITCH_CLIENT_ID,
          Authorization: `Bearer ${this.token.access_token}`,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
      });
      if (res.status === 401 && retry) { await this.refresh(); return this.api(url, init, false); }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Twitch HTTP ${res.status}: ${JSON.stringify(body).slice(0, 150)}`);
      return body;
    };
    return go();
  }
  wantedNames() {
    return [...new Set(this.store.list().filter(s =>
      s.platform === 'twitch' && normalizeUploadMode(s.platform, s.mode) !== 'videos')
      .map(s => String(s.username).toLowerCase()))].sort();
  }
  async start() {
    this.token = this.readToken();
    if (!this.token || !this.env.TWITCH_CLIENT_ID || !this.env.TWITCH_CLIENT_SECRET) {
      console.log('[TWITCH-WS] Not configured; Twitch LIVE uses fast polling. Authorize with npm run twitch:auth.');
      return;
    }
    if (!this.WebSocket) {
      console.warn('[TWITCH-WS] Native WebSocket unavailable. Use Node.js 22+ or polling.');
      return;
    }
    this.stopped = false;
    if (this.wantedNames().length) this.connect();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === 1 && this.lastMessage && Date.now() - this.lastMessage > this.keepAlive + 25_000) {
        console.warn('[TWITCH-WS] Keepalive timed out; reconnecting');
        this.ws.close();
      }
    }, 20_000);
    this.heartbeatTimer.unref?.();
    this.syncTimer = setInterval(() => {
      const wanted = this.wantedNames().join(',');
      if (wanted && !this.ws && !this.reconnectTimer) this.connect();
      if (wanted !== this.lastWanted && this.ws?.readyState === 1) {
        // Reconnect with a fresh session for creator list changes.
        this.ws.close(1000, 'Creator list changed');
      }
    }, 60_000);
    this.syncTimer.unref?.();
  }
  connect(url = 'wss://eventsub.wss.twitch.tv/ws?keepalive_timeout_seconds=60', handoffFrom = null) {
    if (this.stopped) return;
    const ws = new this.WebSocket(url);
    if (!handoffFrom) this.ws = ws;
    ws.addEventListener('message', event => {
      void this.handleMessage(event.data, ws, handoffFrom).catch(e => console.error('[TWITCH-WS] Event:', e.message));
    });
    ws.addEventListener('error', () => console.warn('[TWITCH-WS] Connection error; polling remains available'));
    ws.addEventListener('close', () => {
      if (this.stopped) return;
      if (this.ws === ws) {
        this.monitor.fastTwitchWebsocket = false;
        this.monitor.twitchEventSubscribers = new Set();
        this.ws = null;
        if (this.wantedNames().length) this.queueReconnect();
      }
    });
  }
  queueReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(60_000, 2000 * 2 ** Math.min(5, this.retries++));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped) this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }
  async handleMessage(raw, socket, handoffFrom = null) {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    this.lastMessage = Date.now();
    const type = msg.metadata?.message_type;
    if (type === 'session_welcome') {
      this.retries = 0;
      this.keepAlive = Math.max(10, Number(msg.payload?.session?.keepalive_timeout_seconds || 60)) * 1000;
      if (handoffFrom) {
        this.ws = socket;
        handoffFrom.close(1000, 'Twitch handoff complete');
        this.monitor.fastTwitchWebsocket = true;
        console.log('[TWITCH-WS] Switched sessions without losing subscriptions');
      } else {
        const sessionId = msg.payload?.session?.id;
        if (!sessionId) throw new Error('Twitch welcome missing session ID');
        const subscribedNames = await this.subscribe(sessionId);
        this.monitor.twitchEventSubscribers = new Set(subscribedNames);
        this.monitor.fastTwitchWebsocket = subscribedNames.length > 0;
        console.log(`[TWITCH-WS] Live EventSub active for ${subscribedNames.length} broadcasters`);
      }
    } else if (type === 'session_reconnect') {
      const url = msg.payload?.session?.reconnect_url;
      if (typeof url === 'string' && url.startsWith('wss://eventsub.wss.twitch.tv/')) this.connect(url, socket);
    } else if (type === 'notification' && msg.payload?.subscription?.type === 'stream.online') {
      const e = msg.payload.event;
      if (!e?.id || !e.broadcaster_user_login) return;
      const login = e.broadcaster_user_login.toLowerCase();
      const item = { live:true, id:String(e.id), creator:e.broadcaster_user_name || login,
        title:'LIVE on Twitch', url:`https://www.twitch.tv/${login}`, platform:'Twitch', viewers:'?' };
      for (const sub of this.store.list().filter(s => s.platform === 'twitch' &&
        s.username.toLowerCase() === login && normalizeUploadMode(s.platform, s.mode) !== 'videos')) {
        await this.monitor.process(sub, item);
      }
    } else if (type === 'revocation') {
      console.warn('[TWITCH-WS] A subscription was revoked; fallback Twitch polling remains enabled');
    }
  }
  async subscribe(sessionId) {
    const wanted = this.wantedNames();
    this.lastWanted = wanted.join(',');
    if (!wanted.length) return [];
    // Twitch websocket limit: generally 10 cost points for arbitrary broadcasters
    // under one user token. Extra streamers continue fast polling.
    const selected = wanted.slice(0, 10);
    if (wanted.length > 10) console.warn('[TWITCH-WS] WebSocket covers 10 creators; others use fast polling.');
    const headers = {};
    const users = new Map();
    for (let i = 0; i < selected.length; i += 100) {
      const params = new URLSearchParams();
      for (const username of selected.slice(i, i + 100)) params.append('login', username);
      const info = await this.api(`${BASE}/users?${params}`, { headers });
      for (const u of info.data || []) users.set(u.login?.toLowerCase(), u.id);
    }
    const subscribed = [];
    for (const login of selected) {
      const id = users.get(login);
      if (!id) { console.warn(`[TWITCH-WS] ${login}: Twitch user not found`); continue; }
      try {
        await this.api(`${BASE}/eventsub/subscriptions`, { method:'POST', body:JSON.stringify({
          type:'stream.online', version:'1', condition:{broadcaster_user_id:id},
          transport:{method:'websocket', session_id:sessionId},
        }) });
        subscribed.push(login);
      } catch (e) { console.warn(`[TWITCH-WS] ${login}: ${e.message}`); }
    }
    return subscribed;
  }
  stop() {
    this.stopped = true;
    this.monitor.fastTwitchWebsocket = false;
    this.monitor.twitchEventSubscribers = new Set();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.syncTimer) clearInterval(this.syncTimer);
    this.ws?.close();
  }
}
