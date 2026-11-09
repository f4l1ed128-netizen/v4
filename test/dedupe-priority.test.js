import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Monitor } from '../src/monitor.js';

const vid = (id, at) => ({ id, title: `Video ${id}`, creator: 'Maro', platform: 'YouTube', url: `https://youtube.com/watch?v=${id}`, publishedAt: at });
const live = (id) => ({ live: true, id, creator: 'Maro', title: 'Live now', url: `https://youtube.com/watch?v=${id}`, platform: 'YouTube' });
const offline = () => ({ live: false });
const sub = { id:'maro', guildId:'guild', destinationId:'channel', username:'maro', channelId:'UCmaro', platform:'youtube', mode:'both', initialized: true, wasLive: false, offlineChecks:2, uploadsInitialized:true, lastStatus:'OFFLINE', seenUploadIds:['old'], announcedVideoIds:['old'], seenStreamIds:[] };
function setup(initial = {}, fakePlatforms = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dedupe-exact-'));
  const store = new Store(dir); store.add({ ...sub, ...initial });
  const posts = [];
  const client = { channels: { fetch: async () => ({ isTextBased:()=>true, send: async payload=>{ posts.push(payload); await new Promise(r=>setTimeout(r,10)); } }) } };
  const platforms = {check: async()=>offline(), uploads:async()=>({allIds:['old'], videos:[vid('old','2026-10-29')] }), ...fakePlatforms};
  const monitor = new Monitor(client, store, platforms, { interval:60 });
  return {dir, store, posts, platforms, monitor, client, cleanup:()=>fs.rmSync(dir,{recursive:true,force:true})};
}

test('automatic poll: LIVE priority wins, even when there is a new upload', async()=>{
  let uploadRequests = 0;
  const h=setup({}, {check:async()=>live('stream-A'), uploads:async()=>{uploadRequests++; return {allIds:['video-B'],videos:[vid('video-B','2026-10-30')]};}});
  try {
    await h.monitor.tick();
    assert.equal(h.posts.length,1); assert.match(h.posts[0].content,/stream-A/);
    assert.equal(uploadRequests,0,'should not even request video feed while LIVE');
    await h.monitor.tick();
    assert.equal(h.posts.length,1,'same stream never announced twice');
  } finally {h.cleanup();}
});

test('automatic poll: offline new latest video sends once; repeat same newest sends nothing', async()=>{
  const h=setup({}, {uploads:async()=>({allIds:['new','old'],videos:[vid('new','2026-10-30'),vid('old','2026-10-29')]})});
  try {
    await h.monitor.tick();
    assert.equal(h.posts.length,1); assert.match(h.posts[0].content,/new/);
    await h.monitor.tick();
    assert.equal(h.posts.length,1);
    assert.ok(h.store.find('guild','maro').announcedVideoIds.includes('new'));
  } finally {h.cleanup();}
});

test('offline latest already handled: does not post an older unseen video either', async()=>{
  const h=setup({seenUploadIds:['latest'],announcedVideoIds:['latest']}, {uploads:async()=>({allIds:['latest','older'],videos:[vid('latest','2026-10-30'),vid('older','2026-10-29')]})});
  try { await h.monitor.tick(); assert.equal(h.posts.length,0); } finally {h.cleanup();}
});

test('new video after old video was handled sends once (not the whole backlog)',async()=>{
  const h=setup({}, {uploads:async()=>({allIds:['newest','middle','old'],videos:[vid('newest','2026-10-31'),vid('middle','2026-10-30'),vid('old','2026-10-29')]})});
  try { await h.monitor.tick(); assert.equal(h.posts.length,1); assert.match(h.posts[0].content,/newest/); await h.monitor.tick(); assert.equal(h.posts.length,1); } finally {h.cleanup();}
});

test('stream first test: already-announced stream sends nothing, without falling back to videos',async()=>{
  let videoCalls=0;
  const h=setup({lastStreamId:'stream-A',seenStreamIds:['stream-A'],wasLive:true,lastStatus:'LIVE'}, {check:async()=>live('stream-A'),uploads:async()=>{videoCalls++; return {allIds:['new'],videos:[vid('new','2026-10-30')]};}});
  try { await assert.rejects(()=>h.monitor.sendTest(sub,'stream'),/Nothing new/); assert.equal(h.posts.length,0); assert.equal(videoCalls,0); } finally {h.cleanup();}
});

test('stream first test: offline and latest already handled means NOTHING is sent', async()=>{
  const h=setup({seenUploadIds:['latest'],announcedVideoIds:['latest']}, {check:async()=>offline(),uploads:async()=>({allIds:['latest'],videos:[vid('latest','2026-10-30')]})});
  try { await assert.rejects(()=>h.monitor.sendTest(sub,'stream'),/Nothing new/); assert.equal(h.posts.length,0); } finally {h.cleanup();}
});

test('test and automatic polling at same time only send the new item once',async()=>{
  const h=setup({}, {check:async()=>offline(),uploads:async()=>({allIds:['new'],videos:[vid('new','2026-10-30')]})});
  try {
    const results = await Promise.allSettled([h.monitor.sendTest(sub,'stream'),h.monitor.tick()]);
    assert.equal(h.posts.length,1);
    assert.ok(results.some(r=>r.status==='fulfilled'));
  } finally {h.cleanup();}
});

test('across restart, previously announced stream and video never repeat even after offline status',async()=>{
  const h=setup({seenStreamIds:['stream-old'],lastStreamId:'stream-old',wasLive:false,offlineChecks:3,seenUploadIds:['video-old'],announcedVideoIds:['video-old']}, {check:async()=>live('stream-old'),uploads:async()=>({allIds:['video-old'],videos:[vid('video-old','2026-10-30')]})});
  try {
    await h.monitor.tick();
    const persisted = new Store(h.dir);
    const restarted = new Monitor(h.client,persisted,h.platforms,{});
    await restarted.tick();
    assert.equal(h.posts.length,0);
    h.platforms.check=async()=>offline();
    await restarted.tick();
    assert.equal(h.posts.length,0);
  } finally {h.cleanup();}
});

test('delivery failure is not recorded as successful; subsequent check can retry',async()=>{
  const h=setup({}, {uploads:async()=>({allIds:['new'],videos:[vid('new','2026-10-30')]})});
  try {
    h.client.channels.fetch=async()=>({isTextBased:()=>true,send:async()=>{throw new Error('no permission')}});
    await h.monitor.tick();
    assert.ok(!h.store.find('guild','maro').seenUploadIds.includes('new'));
    h.client.channels.fetch=async()=>({isTextBased:()=>true,send:async payload=>h.posts.push(payload)});
    await h.monitor.tick();
    assert.equal(h.posts.length,1);
  } finally {h.cleanup();}
});
