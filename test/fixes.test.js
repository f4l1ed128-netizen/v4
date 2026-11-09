import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { parseCreator, Platforms } from '../src/platforms.js';

test('YouTube links: handles and channel IDs work, ambiguous links are rejected', () => {
  const uc = 'UC' + 'a'.repeat(22);
  assert.equal(parseCreator('youtube', 'https://www.youtube.com/@developer').username, 'developer');
  assert.equal(parseCreator('youtube', `https://www.youtube.com/channel/${uc}`).channelId, uc);
  assert.equal(parseCreator('youtube', '@handle').username, 'handle');
  assert.throws(() => parseCreator('youtube', 'https://www.youtube.com/c/SomeName'), /@handle/);
  assert.throws(() => parseCreator('youtube', 'https://youtu.be/dQw4w9WgXcQ'), /@handle/);
  assert.throws(() => parseCreator('youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ'), /@handle/);
});

test('legacy /user/ links resolve with forUsername, not forHandle', async () => {
  const parsed = parseCreator('youtube', 'https://www.youtube.com/user/LegacyName');
  assert.equal(parsed.legacyUsername, 'LegacyName');
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async url => { calls.push(String(url)); return new Response(JSON.stringify({ items: [{ id: 'UC' + 'b'.repeat(22), snippet: { title: 'Legacy' }, contentDetails: { relatedPlaylists: { uploads: 'UU1' } } }] }), { status: 200 }); };
  try {
    const out = await new Platforms({ YOUTUBE_API_KEY: 'k' }).resolveYoutube(parsed);
    assert.match(calls[0], /forUsername=LegacyName/);
    assert.doesNotMatch(calls[0], /forHandle/);
    assert.equal(out.channelId, 'UC' + 'b'.repeat(22));
  } finally { globalThis.fetch = realFetch; }
});

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mg3-store-')); }
const quiet = fn => { const e = console.error; console.error = () => {}; try { return fn(); } finally { console.error = e; } };

test('corrupt alerts.json is restored from the last good backup', () => {
  const dir = tmp();
  try {
    const s = new Store(dir);
    s.add({ guildId: 'g', id: 'one' });
    s.add({ guildId: 'g', id: 'two' }); // backup now holds the version with 'one'
    fs.writeFileSync(path.join(dir, 'alerts.json'), '{ not json');
    const restored = quiet(() => new Store(dir));
    assert.ok(restored.list().length >= 1);
    assert.ok(fs.readdirSync(dir).some(f => f.includes('.corrupt-')), 'damaged file kept aside');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('corrupt alerts.json with no backup starts empty without crashing and keeps the damaged file', () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'alerts.json'), '{ not json');
    const s = quiet(() => new Store(dir));
    assert.deepEqual(s.list(), []);
    assert.ok(fs.readdirSync(dir).some(f => f.includes('.corrupt-')));
    s.add({ guildId: 'g', id: 'x' });
    assert.equal(new Store(dir).list().length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
