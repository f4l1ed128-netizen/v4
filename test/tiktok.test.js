import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Platforms } from '../src/platforms.js';
import { Store } from '../src/store.js';
import { Monitor } from '../src/monitor.js';
import { normalizeUploadMode, supportsVideoUploads } from '../src/uploads.js';

const item = { id: 'tk1', guildId: 'g1', platform: 'tiktok', username: 'testcreator', displayName: 'Tester',
  destinationId: 'd1', profileUrl: 'https://www.tiktok.com/@testcreator/live', mode: 'both',
  pingMode: 'everyone', videoPingMode: 'none', uploadsInitialized: false };
const result = (ids) => ({ code: 0, data: { videos: ids.map((id, i) => ({
  video_id: id, title: `TikTok post ${i}`, create_time: 1793000000 + Number(id.slice(-3)),
})) } });

function withFakeFetch(body, fn) {
  const original = globalThis.fetch;
  let calledUrl;
  globalThis.fetch = async (url) => {
    calledUrl = String(url);
    return { ok: true, json: async () => body };
  };
  return Promise.resolve().then(() => fn(() => calledUrl))
    .finally(() => { globalThis.fetch = original; });
}

test('TikTok mode supports streams/videos/both, legacy TikTok remains streams-only', () => {
  assert.equal(normalizeUploadMode('tiktok', undefined), 'streams');
  assert.equal(normalizeUploadMode('tiktok', 'both'), 'both');
  assert.equal(normalizeUploadMode('tiktok', 'videos'), 'videos');
  assert.equal(normalizeUploadMode('twitch', 'videos'), 'streams');
  assert.equal(supportsVideoUploads('tiktok'), true);
});

test('TikTok posts provider uses fixed endpoint and returns exact direct video links', async () => {
  const id = '7291234567890123456';
  await withFakeFetch(result([id]), async url => {
    const platform = new Platforms();
    const { allIds, videos } = await platform.uploads(item);
    assert.match(url(), /^https:\/\/www\.tikwm\.com\/api\/user\/posts\?unique_id=testcreator&count=20$/);
    assert.deepEqual(allIds, [id]);
    assert.equal(videos[0].url, `https://www.tiktok.com/@testcreator/video/${id}`);
    assert.equal(videos[0].platform, 'TikTok');
    assert.equal(videos[0].publishedAt.startsWith('2026-'), true);
  });
});

test('provider error or malformed payload is surfaced, not silently treated as no uploads', async () => {
  await withFakeFetch({ code: 402, msg: 'Temporarily unavailable' }, async () => {
    await assert.rejects(() => new Platforms().tiktokUploads(item), /no usable feed/);
  });
  await withFakeFetch({ code: 0, data: { videos: [{}] } }, async () => {
    await assert.rejects(() => new Platforms().tiktokUploads(item), /invalid video IDs/);
  });
});

test('TikTok new posts baseline, announce only new ones, preserve dedupe across restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-tiktok-v3-'));
  try {
    const store = new Store(dir);
    store.add(item);
    const delivered = [];
    const client = { channels: { fetch: async () => ({ isTextBased: () => true, send: async payload => delivered.push(payload) }) } };
    const monitor = new Monitor(client, store, new Platforms());
    const older = '7291234567890123456';
    const newer = '7291234567890123457';
    await withFakeFetch(result([older]), async () => {
      await monitor.processUploads(item, await monitor.platforms.tiktokUploads(item));
    });
    assert.equal(delivered.length, 0);
    assert.equal(store.find('g1', 'tk1').uploadsInitialized, true);
    await withFakeFetch(result([newer, older]), async () => {
      await monitor.processUploads(item, await monitor.platforms.tiktokUploads(item));
    });
    assert.equal(delivered.length, 1);
    assert.match(delivered[0].content, new RegExp(`${newer}`));
    assert.deepEqual(delivered[0].allowedMentions.parse, []);
    const restarted = new Monitor(client, new Store(dir), new Platforms());
    await withFakeFetch(result([newer, older]), async () => {
      await restarted.processUploads(item, await restarted.platforms.tiktokUploads(item));
    });
    assert.equal(delivered.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('TikTok LIVE takes priority; upload feed is not queried during live checks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-tiktok-mixed-'));
  try {
    const store = new Store(dir); store.add({ ...item, initialized: true, lastStreamId: null, offlineChecks: 2, wasLive: false });
    const delivered = [];
    const platforms = { check: async () => ({ live: true, id: 'live123', creator: 'Tester', url: item.profileUrl }),
      uploads: async () => { throw new Error('Provider rate limited'); } };
    const client = { channels: { fetch: async () => ({ isTextBased: () => true, send: async p => delivered.push(p) }) } };
    const monitor = new Monitor(client, store, platforms);
    await monitor.tick();
    assert.equal(delivered.length, 1);
    assert.equal(store.find('g1', 'tk1').lastError, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
