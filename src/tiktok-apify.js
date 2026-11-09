// TikTok Apify fallback; loaded by src/index.js when APIFY_TOKEN is set.
// Audience-controlled profiles may remain inaccessible.
// Stores failure results in cache to avoid repeated paid checks.
// Uses APIFY_TOKEN set privately in hosting environment variables.
import { Platforms } from './platforms.js';

const oldUploads = Platforms.prototype.tiktokUploads;
const cache = new Map();
const inflight = new Map();
const ACTOR = 'clockworks~tiktok-profile-scraper';
const BASE = 'https://api.apify.com/v2';

function handleOf(value) {
  const text = String(value || '').trim().replace(/^@/, '').toLowerCase();
  if (!/^[a-z0-9_.-]{1,80}$/.test(text)) throw new Error('Invalid TikTok username.');
  return text;
}

async function api(path, token, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...options,
    signal: AbortSignal.timeout(70000),
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || response.statusText;
    throw new Error(`Apify HTTP ${response.status}: ${String(message).slice(0, 150)}`);
  }
  return payload;
}

function parsePosts(items, handle, runId) {
  if (!Array.isArray(items)) throw new Error('Apify returned an invalid dataset.');
  const posts = new Map();
  const problems = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    if (item.errorCode || item.error || item.noteCode) {
      problems.push(`${item.errorCode || item.noteCode || 'ERROR'}: ${String(item.error || item.note || '').slice(0, 90)}`);
      continue;
    }
    const rawUrl = String(item.webVideoUrl || item.url || '');
    const urlMatch = /^https:\/\/(?:www\.)?tiktok\.com\/@([a-z0-9_.-]+)\/(?:video|photo)\/(\d{10,25})/i.exec(rawUrl);
    const id = String(item.id ?? item.videoId ?? item.awemeId ?? urlMatch?.[2] ?? '');
    if (!/^\d{10,25}$/.test(id) || posts.has(id)) continue;
    const author = String(item.authorMeta?.name || item.author?.uniqueId || urlMatch?.[1] || '').replace(/^@/, '').toLowerCase();
    if (author && author !== handle) continue; // do not announce other creators
    const millis = Date.parse(item.createTimeISO || '');
    const rawTime = Number(item.createTime || item.create_time || 0);
    const timestamp = Number.isFinite(millis) ? millis : (rawTime > 1e11 ? rawTime : rawTime * 1000);
    const publishedAt = timestamp > 0 && Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
    posts.set(id, {
      id, creator: item.authorMeta?.nickName || item.author?.nickname || handle,
      title: String(item.text || item.desc || item.title || 'New TikTok post').slice(0, 200),
      platform: 'TikTok', viewers: '?',
      url: (urlMatch && urlMatch[1].toLowerCase() === handle && urlMatch[2] === id)
        ? rawUrl : `https://www.tiktok.com/@${handle}/video/${id}`,
      publishedAt,
    });
  }
  if (!posts.size) {
    const detail = problems[0] || (items.length ? `${items.length} dataset rows, but none contained matching public video IDs` : 'empty dataset');
    throw new Error(`Apify found no usable posts (${detail}). Run logs: https://console.apify.com/view/runs/${runId}`);
  }
  const videos = [...posts.values()].sort((a, b) =>
    (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0));
  return { allIds: videos.map(v => v.id), videos };
}

async function fetchProfile(handle, token, limit) {
  // Use Clockworks' profile-specific actor instead of the general-purpose one.
  // Unlike the sync dataset endpoint, this gives us the run status and logs URL.
  const input = {
    profiles: [handle], resultsPerPage: limit,
    profileScrapeSections: ['videos'], profileSorting: 'latest',
    excludePinnedPosts: false, shouldDownloadVideos: false,
    shouldDownloadCovers: false, commentsPerPost: 0,
  };
  let run = (await api(`/acts/${ACTOR}/runs?waitForFinish=55`, token, {
    method: 'POST', body: JSON.stringify(input),
  })).data;
  if (!run?.id) throw new Error('Apify did not return a run ID.');
  const logUrl = `https://console.apify.com/view/runs/${run.id}`;
  if (!['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED'].includes(run.status)) {
    run = (await api(`/actor-runs/${encodeURIComponent(run.id)}?waitForFinish=40`, token)).data;
  }
  if (run?.status !== 'SUCCEEDED') {
    throw new Error(`Apify run ${run?.status || 'unknown'}: ${String(run?.statusMessage || 'see logs').slice(0, 100)}. Logs: ${logUrl}`);
  }
  const datasetId = run.defaultDatasetId;
  if (!datasetId) throw new Error(`Apify run completed without a dataset. Logs: ${logUrl}`);
  const items = await api(`/datasets/${encodeURIComponent(datasetId)}/items?clean=false&limit=${Math.max(5, limit + 3)}`, token);
  return parsePosts(items, handle, run.id);
}

Platforms.prototype.tiktokUploads = async function (subscription) {
  const token = String(this.env?.APIFY_TOKEN || process.env.APIFY_TOKEN || '').trim();
  if (!token) return oldUploads.call(this, subscription);
  const handle = handleOf(subscription.username);
  const key = handle;
  const cached = cache.get(key);
  if (cached && cached.expires > Date.now()) {
    if (cached.error) throw new Error(cached.error);
    return cached.value;
  }
  if (inflight.has(key)) return inflight.get(key);
  const minutes = Math.max(30, Math.min(1440,
    Number(this.env?.TIKTOK_APIFY_INTERVAL_MINUTES || 30) || 30));
  const limit = Math.max(1, Math.min(10,
    Number(this.env?.TIKTOK_APIFY_RESULTS || 3) || 3));
  const task = (async () => {
    try {
      const value = await fetchProfile(handle, token, limit);
      cache.set(key, { value, expires: Date.now() + minutes * 60000 });
      return value;
    } catch (error) {
      // Do not rerun Apify through an older patched platforms.js. The free
      // fallback must not make a second paid Apify request in the same check.
      const fallbackThis = Object.create(this);
      fallbackThis.env = { ...this.env, APIFY_TOKEN: '' };
      let freeError;
      try { return await oldUploads.call(fallbackThis, subscription); }
      catch (e) { freeError = e; }
      const message = `TikTok posts unavailable. ${error.message}; free source: ${String(freeError?.message || 'unavailable').slice(0, 150)}`;
      cache.set(key, { error: message, expires: Date.now() + minutes * 60000 });
      throw new Error(message);
    }
  })().finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
};

