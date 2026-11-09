import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from '../src/store.js';
import { parseCreator } from '../src/platforms.js';
import { buildAlertPayload, renderTemplate, DEFAULT_TEMPLATE } from '../src/template.js';
import { Monitor } from '../src/monitor.js';

const base = { id: 'abc123', guildId: 'g', platform: 'twitch', username: 'alice', displayName: 'Alice',
  destinationId: 'c', profileUrl: 'https://twitch.tv/alice', template: DEFAULT_TEMPLATE,
  pingMode: 'everyone', initialized: false, wasLive: false, lastStreamId: null, offlineChecks: 0 };
const makeStore = () => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alerts-')); const store = new Store(dir); return { dir, store }; };
function makeMonitor(store, result, posts) {
  return new Monitor({ channels: { fetch: async () => ({ isTextBased: () => true, send: async payload => posts.push(payload) }) } },
    store, { check: async () => result }, { interval: 60 });
}

test('parses supported creator links and rejects wrong domains', () => {
  assert.equal(parseCreator('tiktok', 'https://www.tiktok.com/@MyCreator/live').username, 'mycreator');
  assert.equal(parseCreator('twitch', 'https://www.twitch.tv/Ninja').username, 'ninja');
  assert.equal(parseCreator('kick', 'https://kick.com/someone').username, 'someone');
  assert.equal(parseCreator('youtube', 'https://www.youtube.com/@developer').username, 'developer');
  assert.throws(() => parseCreator('twitch', 'https://example.org/ninja'));
});

test('renders placeholder text and only enables the configured mention', () => {
  const info = { creator: 'Creator @everyone', platform: 'Twitch', title: 'Go @here', url: 'https://twitch.tv/creator' };
  const payload = buildAlertPayload({ ...base, pingMode: 'everyone' }, info);
  assert.ok(payload.content.includes('@\u200beveryone'));
  assert.ok(payload.content.includes('@\u200bhere'));
  assert.equal(payload.allowedMentions.parse[0], 'everyone');
  assert.equal(renderTemplate('{ping}', info, 'role', '123'), '<@&123>');
  assert.deepEqual(buildAlertPayload({ ...base, pingMode: 'none' }, info).allowedMentions.parse, []);
});

test('persists creator records and settings across reloads', () => {
  const { dir, store } = makeStore();
  store.add({ ...base });
  store.patch('g', 'abc123', { template: 'Hi {ping}', pingMode: 'role', roleId: 'abc' });
  const again = new Store(dir);
  assert.equal(again.find('g', 'abc123').template, 'Hi {ping}');
  assert.equal(again.find('g', 'abc123').roleId, 'abc');
  assert.ok(again.remove('g', 'abc123'));
  assert.equal(again.list('g').length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('new subscriptions baseline live streams rather than spam alert', async () => {
  const { dir, store } = makeStore(); const posts = [];
  store.add({ ...base });
  const live = { live: true, id: 'one', creator: 'Alice', title: 'Live', platform: 'Twitch', url: base.profileUrl };
  const monitor = makeMonitor(store, live, posts);
  await monitor.process(base, live);
  await monitor.process(base, live);
  assert.equal(posts.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('posts once per new stream and survives restart', async () => {
  const { dir, store } = makeStore(); const posts = [];
  store.add({ ...base });
  const monitor = makeMonitor(store, {}, posts);
  await monitor.process(base, { live: false });
  const one = { live: true, id: 'one', creator: 'Alice', title: 'Morning', platform: 'Twitch', url: base.profileUrl };
  await monitor.process(base, one);
  await monitor.process(base, one);
  assert.equal(posts.length, 1);
  const newStore = new Store(dir);
  const newMonitor = makeMonitor(newStore, one, posts);
  await newMonitor.process(base, one);
  assert.equal(posts.length, 1);
  await newMonitor.process(base, { live: true, id: 'two', creator: 'Alice', title: 'Evening', platform: 'Twitch', url: base.profileUrl });
  assert.equal(posts.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('treats errors as errors, not offline, and retries send', async () => {
  const { dir, store } = makeStore(); const posts = [];
  store.add({ ...base });
  const monitor = makeMonitor(store, {}, posts);
  await monitor.process(base, { live: false });
  const failed = { live: true, id: 'x', creator: 'Alice', title: 'Live', platform: 'Twitch', url: base.profileUrl };
  const old = monitor.client.channels.fetch;
  monitor.client.channels.fetch = async () => ({ isTextBased: () => true, send: async () => { throw new Error('No permission'); } });
  await assert.rejects(() => monitor.process(base, failed), /No permission/);
  monitor.client.channels.fetch = old;
  await monitor.process(base, failed);
  assert.equal(posts.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
