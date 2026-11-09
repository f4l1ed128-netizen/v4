import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Monitor } from '../src/monitor.js';
import { Platforms } from '../src/platforms.js';
import { buildAlertPayload, DEFAULT_VIDEO_TEMPLATE } from '../src/template.js';
import { normalizeYouTubeMode, newUploadVideos } from '../src/uploads.js';

const video = (id, date) => ({ id, title: `Video ${id}`, creator: 'Creator', platform: 'YouTube', url: `https://www.youtube.com/watch?v=${id}`, publishedAt: date });
const base = { id: 'x', guildId: 'guild', platform: 'youtube', username: 'creator', channelId: 'UC' + 'a'.repeat(22),
  profileUrl: 'https://youtube.com/@creator', displayName: 'Creator', destinationId: 'dest',
  mode: 'both', videoTemplate: DEFAULT_VIDEO_TEMPLATE, videoPingMode: 'none', pingMode: 'everyone',
  initialized: false, uploadsInitialized: false };
function harness() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alerts-uploads-'));
  const store = new Store(dir); store.add({ ...base });
  const posts = [];
  const client = { channels: { fetch: async () => ({ isTextBased: () => true, send: async v => { posts.push(v); } }) } };
  return { dir, store, posts, client, monitor: new Monitor(client, store, {}, { interval: 120 }) };
}

test('new uploaded videos appear oldest first and YouTube modes are backward compatible', () => {
  assert.equal(normalizeYouTubeMode('youtube', undefined), 'streams');
  assert.equal(normalizeYouTubeMode('youtube', 'both'), 'both');
  assert.equal(normalizeYouTubeMode('tiktok', 'both'), 'both');
  assert.equal(normalizeYouTubeMode('tiktok', undefined), 'streams');
  const list = [video('new', '2026-10-30T12:00:00Z'), video('old', '2026-10-29T10:00:00Z')];
  assert.deepEqual(newUploadVideos(list, []).map(v => v.id), ['old', 'new']);
  assert.deepEqual(newUploadVideos(list, ['old']).map(v => v.id), ['new']);
});

test('upload notifications baseline, send new videos once, persist, and use separate ping mode', async () => {
  const h = harness();
  try {
    await h.monitor.processUploads(base, { allIds: ['video1'], videos: [video('video1', '2026-10-29')] });
    assert.equal(h.posts.length, 0);
    await h.monitor.processUploads(base, { allIds: ['video2', 'video1'], videos: [video('video2', '2026-10-30'), video('video1', '2026-10-29')] });
    assert.equal(h.posts.length, 1);
    assert.match(h.posts[0].content, /video2/);
    assert.deepEqual(h.posts[0].allowedMentions.parse, []);
    assert.ok(!h.posts[0].content.includes('@everyone'));
    await h.monitor.processUploads(base, { allIds: ['video2', 'video1'], videos: [video('video2', '2026-10-30'), video('video1', '2026-10-29')] });
    const restored = new Store(h.dir);
    const monitor = new Monitor(h.client, restored, {}, {});
    await monitor.processUploads(base, { allIds: ['video2', 'video1'], videos: [video('video2', '2026-10-30')] });
    assert.equal(h.posts.length, 1);
  } finally { fs.rmSync(h.dir, { recursive: true, force: true }); }
});

test('failed upload notifications retry safely on the next check', async () => {
  const h = harness();
  try {
    await h.monitor.processUploads(base, { allIds: ['one'], videos: [video('one', '2026-10-29')] });
    h.client.channels.fetch = async () => ({ isTextBased: () => true, send: async () => { throw new Error('Permission denied'); } });
    await assert.rejects(() => h.monitor.processUploads(base, { allIds: ['two', 'one'], videos: [video('two', '2026-10-30')] }), /Permission denied/);
    assert.equal(h.store.find('guild', 'x').seenUploadIds.includes('two'), false);
    h.client.channels.fetch = async () => ({ isTextBased: () => true, send: async v => h.posts.push(v) });
    await h.monitor.processUploads(base, { allIds: ['two', 'one'], videos: [video('two', '2026-10-30')] });
    assert.equal(h.posts.length, 1);
  } finally { fs.rmSync(h.dir, { recursive: true, force: true }); }
});

test('YouTube uploads request uses official playlists and filters out live sessions', async () => {
  const origFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async url => {
    const u = new URL(url); requested.push(u.pathname);
    let items = [];
    if (u.pathname.endsWith('/channels')) items = [{ contentDetails: { relatedPlaylists: { uploads: 'UUfoo' } } }];
    if (u.pathname.endsWith('/playlistItems')) items = [
      { contentDetails: { videoId: 'upload123' } }, { contentDetails: { videoId: 'livestream456' } },
    ];
    if (u.pathname.endsWith('/videos')) items = [
      { id: 'upload123', snippet: { title: 'New Upload', publishedAt: '2026-10-30', channelTitle: 'Creator', liveBroadcastContent: 'none' }, status: { privacyStatus: 'public' } },
      { id: 'livestream456', snippet: { title: 'Replay', liveBroadcastContent: 'none' }, liveStreamingDetails: { actualStartTime: '2026-10-30T10:00:00Z' }, status: { privacyStatus: 'public' } },
    ];
    return { ok: true, json: async () => ({ items }) };
  };
  try {
    const p = new Platforms({ YOUTUBE_API_KEY: 'test' });
    const result = await p.youtubeUploads(base);
    assert.deepEqual(result.allIds, ['upload123', 'livestream456']);
    assert.deepEqual(result.videos.map(v => v.id), ['upload123']);
    assert.deepEqual(requested, ['/youtube/v3/channels', '/youtube/v3/playlistItems', '/youtube/v3/videos']);
  } finally { globalThis.fetch = origFetch; }
});

test('upload notification payload uses upload template and independent role permissions', () => {
  const message = buildAlertPayload({ ...base, videoPingMode: 'role', videoRoleId: '1234' }, video('q', 'today'), false, 'video');
  assert.ok(message.content.includes('uploaded a new video'));
  assert.ok(message.content.includes('<@&1234>'));
  assert.deepEqual(message.allowedMentions.roles, ['1234']);
  assert.deepEqual(message.allowedMentions.parse, []);
});

test('upgrading V1 with an everyone stream ping does not unexpectedly ping uploads', () => {
  const legacy = { ...base, videoPingMode: undefined, videoRoleId: undefined, pingMode: 'everyone' };
  const payload = buildAlertPayload(legacy, video('x', '2026-10-30'), false, 'video');
  assert.deepEqual(payload.allowedMentions.parse, []);
  assert.ok(!payload.content.includes('@everyone'));
});
