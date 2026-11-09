const NAME_RE = /^[\p{L}\p{N}_.-]{1,80}$/u;
const UC_RE = /^UC[\w-]{22}$/;

export function parseCreator(platform, value) {
  const original = String(value || '').trim();
  if (!original) throw new Error('Provide a creator username or profile URL.');
  let v = original;
  if (/^https?:\/\//i.test(original)) {
    let url;
    try { url = new URL(original); } catch { throw new Error('Invalid URL.'); }
    const host = url.hostname.toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
    const allowed = {
      twitch: ['twitch.tv'], kick: ['kick.com'], youtube: ['youtube.com', 'youtu.be'],
      tiktok: ['tiktok.com'],
    };
    if (!allowed[platform]?.includes(host)) throw new Error(`That URL is not a ${platform} creator link.`);
    const parts = url.pathname.split('/').filter(Boolean);
    if (platform === 'youtube') {
      const first = parts[0] || '';
      if (first.startsWith('@') && first.length > 1) v = first;
      else if (first === 'channel' && parts[1]) v = parts[1];
      else if (first === 'user' && parts[1]) {
        // Legacy username URL: resolved with the API's forUsername lookup.
        const legacy = parts[1];
        if (!NAME_RE.test(legacy)) throw new Error('Invalid YouTube username in link.');
        return { username: legacy, channelId: null, legacyUsername: legacy, profileUrl: `https://www.youtube.com/user/${legacy}` };
      } else {
        throw new Error('Use a YouTube @handle link (youtube.com/@name) or a youtube.com/channel/UC... link. Video, /c/ and youtu.be links cannot be resolved reliably.');
      }
    } else {
      v = parts[0];
    }
  }
  v = String(v || '').replace(/^@/, '');
  if (platform === 'youtube') {
    if (UC_RE.test(v)) return { username: v, channelId: v, profileUrl: `https://www.youtube.com/channel/${v}` };
    if (!NAME_RE.test(v)) throw new Error('Use a YouTube @handle or /channel/UC... link.');
    return { username: v, channelId: null, profileUrl: `https://www.youtube.com/@${v}` };
  }
  if (!NAME_RE.test(v)) throw new Error('Invalid username. Use the creator profile link or handle.');
  const username = v.toLowerCase();
  const profileUrl = platform === 'tiktok' ? `https://www.tiktok.com/@${username}/live` : `https://${platform}.com/${username}`;
  return { username, profileUrl };
}

async function requestJson(url, init = {}) {
  const signal = AbortSignal.timeout(15000);
  const response = await fetch(url, { ...init, signal, headers: { 'Accept': 'application/json', ...init.headers } });
  let body;
  try { body = await response.json(); } catch { body = {}; }
  if (!response.ok) {
    const message = typeof body?.error?.message === 'string' ? body.error.message : (body.message || body.error_description || 'API request failed');
    throw new Error(`HTTP ${response.status}: ${String(message).slice(0, 180)}`);
  }
  return body;
}

// TikTok is not an official public API. Use public metadata only; never turn a
// provider failure into an "offline" or "no posts" result.
const TIKTOK_ID = /^\d{10,25}$/;
const tikTokHandle = value => {
  const h = String(value || '').replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_.-]{1,80}$/.test(h)) throw new Error('Invalid TikTok username.');
  return h;
};
function tikTokPost(id, item, handle) {
  const seconds = Number(item.create_time ?? item.createTime ?? item.createTimeISO ?? 0);
  const publishedAt = Number.isFinite(seconds) && seconds > 0 && seconds < 1e11
    ? new Date(seconds * 1000).toISOString() : '';
  return {
    id, creator: item.author?.nickname || item.author?.uniqueId || handle,
    title: String(item.title || item.desc || 'New TikTok post').slice(0, 200),
    platform: 'TikTok', viewers: '?',
    url: `https://www.tiktok.com/@${handle}/video/${id}`, publishedAt,
  };
}
function parseTikwmPosts(json, handle) {
  if (json?.code !== 0 || !Array.isArray(json?.data?.videos)) {
    throw new Error(`TikWM returned no usable feed${json?.msg ? ': ' + String(json.msg).slice(0, 90) : ''}`);
  }
  const posts = json.data.videos;
  const result = new Map();
  for (const post of posts) {
    const id = String(post.video_id ?? post.aweme_id ?? '').trim();
    if (TIKTOK_ID.test(id) && !result.has(id)) result.set(id, tikTokPost(id, post, handle));
  }
  if (posts.length && !result.size) throw new Error('TikWM returned invalid video IDs');
  return { allIds: [...result.keys()], videos: [...result.values()] };
}

function jsonScript(html, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`<script\\b[^>]*\\bid=["']${escaped}["'][^>]*>([\\s\\S]*?)<\\/script>`, 'i');
  const hit = regex.exec(html);
  if (!hit) return null;
  try { return JSON.parse(hit[1].trim()); } catch { return null; }
}

// Public profile HTML may expose SIGI_STATE ItemModule, or direct post links.
// Never invent IDs, and don't mistake a TikTok challenge page for an empty feed.
export function parseTikTokProfilePosts(html, handle) {
  const ids = new Map();
  const root = jsonScript(html, 'SIGI_STATE');
  const itemModule = root?.ItemModule;
  if (itemModule && typeof itemModule === 'object') {
    for (const [key, item] of Object.entries(itemModule)) {
      const id = String(item?.id ?? key);
      if (TIKTOK_ID.test(id) && !ids.has(id)) ids.set(id, tikTokPost(id, item, handle));
    }
  }
  // Some public pages embed a creator's post URLs instead of ItemModule.
  const pattern = new RegExp(`(?:https?:\\/\\/www\\.tiktok\\.com)?\\/\\@${handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/video\\/(\\d{10,25})`, 'gi');
  const normalized = html.replaceAll('\\u002F', '/').replaceAll('\\/', '/');
  for (const match of normalized.matchAll(pattern)) {
    const id = match[1];
    if (TIKTOK_ID.test(id) && !ids.has(id)) ids.set(id, tikTokPost(id, {}, handle));
  }
  if (!ids.size) throw new Error('TikTok profile has no readable public-post metadata (may be blocked or private)');
  return { allIds: [...ids.keys()], videos: [...ids.values()] };
}

async function fetchTikTokPublicProfile(handle) {
  const response = await fetch(`https://www.tiktok.com/@${encodeURIComponent(handle)}`, {
    signal: AbortSignal.timeout(12000),
    headers: { 'Accept': 'text/html', 'User-Agent': 'Mozilla/5.0 (compatible; CreatorLiveAlerts/3.1)' },
  });
  if (!response.ok) throw new Error(`TikTok profile HTTP ${response.status}`);
  const html = await response.text();
  if (html.length > 5_000_000) throw new Error('TikTok profile HTML too large');
  return parseTikTokProfilePosts(html, handle);
}

class TokenProvider {
  constructor() { this.cache = new Map(); }
  async get(platform, id, secret) {
    const old = this.cache.get(platform);
    if (old && old.expires > Date.now() + 60000) return old.token;
    const endpoint = platform === 'twitch' ? 'https://id.twitch.tv/oauth2/token' : 'https://id.kick.com/oauth/token';
    const body = new URLSearchParams({ client_id: id, client_secret: secret, grant_type: 'client_credentials' });
    const json = await requestJson(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    if (!json.access_token) throw new Error(`No ${platform} access token returned.`);
    this.cache.set(platform, { token: json.access_token, expires: Date.now() + Number(json.expires_in || 3600) * 1000 });
    return json.access_token;
  }
}

export class Platforms {
  constructor(env = process.env) {
    this.env = env;
    this.tokens = new TokenProvider();
    this.tiktokConnections = new Map();
    this.youtubePlaylistCache = new Map();
  }
  configured(platform) {
    if (platform === 'youtube') return !!this.env.YOUTUBE_API_KEY;
    if (platform === 'twitch') return !!(this.env.TWITCH_CLIENT_ID && this.env.TWITCH_CLIENT_SECRET);
    if (platform === 'kick') return !!(this.env.KICK_CLIENT_ID && this.env.KICK_CLIENT_SECRET);
    if (platform === 'tiktok') return true; // unofficial dependency, no API key required
    return false;
  }
  async resolveYoutube(creator) {
    if (creator.channelId) return creator;
    const lookup = creator.legacyUsername ? { forUsername: creator.legacyUsername } : { forHandle: creator.username };
    const p = new URLSearchParams({ part: 'snippet,contentDetails', ...lookup, key: this.env.YOUTUBE_API_KEY });
    const json = await requestJson(`https://www.googleapis.com/youtube/v3/channels?${p}`);
    const channel = json.items?.[0];
    if (!channel?.id) throw new Error('YouTube channel not found. Try the youtube.com/channel/UC... link.');
    return { ...creator, channelId: channel.id, username: channel.snippet?.title || creator.username,
      uploadsPlaylistId: channel.contentDetails?.relatedPlaylists?.uploads || null,
      profileUrl: `https://www.youtube.com/channel/${channel.id}` };
  }
  async check(subscription) {
    switch (subscription.platform) {
      case 'twitch': return this.twitch(subscription);
      case 'kick': return this.kick(subscription);
      case 'youtube': return this.youtube(subscription);
      case 'tiktok': return this.tiktok(subscription);
      default: throw new Error('Unknown platform');
    }
  }
  async twitch(s) {
    const token = await this.tokens.get('twitch', this.env.TWITCH_CLIENT_ID, this.env.TWITCH_CLIENT_SECRET);
    const p = new URLSearchParams({ user_login: s.username });
    const json = await requestJson(`https://api.twitch.tv/helix/streams?${p}`, {
      headers: { 'Authorization': `Bearer ${token}`, 'Client-Id': this.env.TWITCH_CLIENT_ID },
    });
    const live = json.data?.find(x => x.type === 'live');
    if (!live) return { live: false };
    return { live: true, id: String(live.id || live.started_at), creator: live.user_name || s.username,
      title: live.title || 'Live now', platform: 'Twitch', viewers: live.viewer_count ?? '?',
      url: `https://www.twitch.tv/${s.username}` };
  }
  async kick(s) {
    const token = await this.tokens.get('kick', this.env.KICK_CLIENT_ID, this.env.KICK_CLIENT_SECRET);
    const p = new URLSearchParams({ slug: s.username });
    const json = await requestJson(`https://api.kick.com/public/v1/channels?${p}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const channel = json.data?.[0];
    if (!channel) throw new Error('Kick channel not found (check slug).');
    const stream = channel.stream;
    if (!stream?.is_live) return { live: false };
    return { live: true, id: String(stream.start_time && !Number.isNaN(Date.parse(stream.start_time)) ? new Date(stream.start_time).toISOString() : `kick:${s.username}`),
      creator: channel.slug || s.username, title: channel.stream_title || 'Live now',
      platform: 'Kick', viewers: stream.viewer_count ?? '?', url: `https://kick.com/${s.username}` };
  }
  async youtube(s) {
    // Official search API, eventType=live. Calls consume YouTube API quota.
    const p = new URLSearchParams({ part: 'snippet', type: 'video', eventType: 'live',
      channelId: s.channelId, maxResults: '5', key: this.env.YOUTUBE_API_KEY });
    const json = await requestJson(`https://www.googleapis.com/youtube/v3/search?${p}`);
    const video = json.items?.find(x => x.id?.videoId && x.snippet?.liveBroadcastContent === 'live');
    if (!video) return { live: false };
    return { live: true, id: video.id.videoId, creator: video.snippet.channelTitle || s.username,
      title: video.snippet.title || 'Live now', platform: 'YouTube', viewers: '?',
      url: `https://www.youtube.com/watch?v=${video.id.videoId}` };
  }
  async uploads(s) {
    if (s.platform === 'youtube') return this.youtubeUploads(s);
    if (s.platform === 'tiktok') return this.tiktokUploads(s);
    throw new Error('Video uploads are only supported for YouTube and TikTok.');
  }
  async tiktokUploads(s) {
    const handle = tikTokHandle(s.username);
    const query = new URLSearchParams({ unique_id: handle, count: '20' });
    let primaryError;
    try {
      const json = await requestJson(`https://www.tikwm.com/api/user/posts?${query}`, {
        headers: { 'User-Agent': 'CreatorLiveAlerts/3.1 (+public-profile-notifications)' },
      });
      return parseTikwmPosts(json, handle);
    } catch (error) {
      primaryError = error;
      console.warn(`[ALERTS] TikTok posts provider error for ${handle}; trying public profile: ${String(error.message).slice(0, 130)}`);
    }
    try {
      return await fetchTikTokPublicProfile(handle);
    } catch (secondary) {
      throw new Error(`TikTok public-post sources unavailable (TikWM: ${String(primaryError?.message).slice(0, 90)}; profile: ${String(secondary.message).slice(0, 100)}). TikTok may be blocking this host.`);
    }
  }
  async youtubeUploads(s) {
    if (!s.channelId) throw new Error('YouTube channel ID is missing. Re-add the creator with a YouTube @handle or channel URL.');
    let playlistId = s.uploadsPlaylistId || this.youtubePlaylistCache.get(s.channelId);
    if (!playlistId) {
      const query = new URLSearchParams({ part: 'contentDetails', id: s.channelId, key: this.env.YOUTUBE_API_KEY });
      const json = await requestJson(`https://www.googleapis.com/youtube/v3/channels?${query}`);
      playlistId = json.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
      if (!playlistId) throw new Error('YouTube uploads playlist unavailable for this channel.');
      this.youtubePlaylistCache.set(s.channelId, playlistId);
    }
    // Low-cost official uploads playlist endpoint. videos.list identifies premieres and past livestreams.
    const query = new URLSearchParams({ part: 'snippet,contentDetails', playlistId, maxResults: '15', key: this.env.YOUTUBE_API_KEY });
    const json = await requestJson(`https://www.googleapis.com/youtube/v3/playlistItems?${query}`);
    const allIds = [...new Set((json.items || []).map(x => x.contentDetails?.videoId || x.snippet?.resourceId?.videoId).filter(Boolean))];
    if (!allIds.length) return { allIds: [], videos: [] };
    const vParams = new URLSearchParams({ part: 'snippet,liveStreamingDetails,status', id: allIds.join(','), key: this.env.YOUTUBE_API_KEY });
    const videos = await requestJson(`https://www.googleapis.com/youtube/v3/videos?${vParams}`);
    const currentlyLive = (videos.items || []).find(v =>
      v.id && v.status?.privacyStatus === 'public' &&
      v.snippet?.liveBroadcastContent === 'live' &&
      !!v.liveStreamingDetails?.actualStartTime
    );
    const activeLive = currentlyLive ? {
      live: true, id: String(currentlyLive.id),
      creator: currentlyLive.snippet?.channelTitle || s.displayName || s.username,
      title: currentlyLive.snippet?.title || 'LIVE on YouTube',
      platform: 'YouTube', viewers: '?',
      url: `https://www.youtube.com/watch?v=${currentlyLive.id}`,
    } : null;
    const eligible = (videos.items || []).filter(v =>
      v.id && v.status?.privacyStatus === 'public' &&
      v.snippet?.liveBroadcastContent === 'none' &&
      !v.liveStreamingDetails?.actualStartTime &&
      !v.liveStreamingDetails?.scheduledStartTime
    ).map(v => ({ id: v.id, creator: v.snippet?.channelTitle || s.displayName || s.username,
      title: v.snippet?.title || 'New video', platform: 'YouTube', viewers: '?',
      url: `https://www.youtube.com/watch?v=${v.id}`, publishedAt: v.snippet?.publishedAt || '' }));
    return { allIds, videos: eligible, activeLive };
  }
  async tiktok(s) {
    // An unofficial status client. Make options explicit for compatibility and
    // avoid long-lived connection state; checking status does not open a socket.
    const { TikTokLiveConnection } = await import('tiktok-live-connector');
    const username = tikTokHandle(s.username);
    const conn = new TikTokLiveConnection(username, {
      processInitialData: false,
      fetchRoomInfoOnConnect: false,
      enableExtendedGiftInfo: false,
      // Optional: newer connector releases can use a signing API key (see README).
      ...(this.env.TIKTOK_SIGN_API_KEY ? { signApiKey: this.env.TIKTOK_SIGN_API_KEY } : {}),
    });
    let isLive;
    try {
      isLive = await conn.fetchIsLive();
    } catch (error) {
      // Some connector releases throw an internal processInitialData error on
      // fetchIsLive(). Try the documented room-info method instead.
      try {
        const info = await conn.fetchRoomInfo();
        const status = Number(info?.status);
        if (status === 2) isLive = true;
        else if (status === 4) isLive = false;
        else throw error;
      } catch (fallback) {
        const msg = String(fallback?.message || error?.message || 'unknown error');
        if (/UserOfflineError|user is offline|user not live|room offline/i.test(msg)) isLive = false;
        else throw new Error(`TikTok LIVE status unavailable: ${String(error?.message || msg).slice(0, 170)}. No false offline status was assumed.`);
      }
    }
    if (!isLive) return { live: false };
    let id = `tiktok:${username}`;
    try { const roomId = await conn.fetchRoomId(); if (roomId) id = `tiktok:${roomId}`; } catch { /* Live known; room ID optional */ }
    return { live: true, id, creator: username, title: 'LIVE on TikTok',
      platform: 'TikTok', viewers: '?', url: `https://www.tiktok.com/@${username}/live` };
  }

}
