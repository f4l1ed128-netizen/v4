import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { Monitor } from '../src/monitor.js';
import { TwitchSocket } from '../src/twitch-ws.js';

const sub = (platform, username, id, mode = 'both') => ({
  platform, username, channelId: platform === 'youtube' ? 'UC0000000000000000000000' : null,
  id, guildId:'g', destinationId:'out', mode, initialized:true, uploadsInitialized:true,
  lastStatus:'OFFLINE', seenStreamIds:[], seenUploadIds:['video-old'], announcedVideoIds:['video-old'],
});
function setup(subs, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'mg3-v6-test-'));
  const store = new Store(dir); subs.forEach(s => store.add(s));
  const posts=[];
  const client={channels:{fetch:async()=>({isTextBased:()=>true,send:async body=>posts.push(body)})}};
  const platforms={check:async()=>({live:false}),uploads:async()=>({allIds:[],videos:[]}),...overrides};
  const monitor=new Monitor(client,store,platforms,{interval:15});
  return {monitor,store,posts,dir,cleanup:()=>fs.rmSync(dir,{recursive:true,force:true})};
}
test('Fast Bot-Hosting settings: independent poll gaps and read budgets', () => {
  const h=setup([sub('youtube','a','a'),sub('kick','b','b')]);
  try {
    assert.equal(h.monitor.interval,15000);
    assert.equal(h.monitor.liveGapMs('kick'),30000);
    assert.equal(h.monitor.liveGapMs('tiktok'),60000);
    assert.equal(h.monitor.youtubeFeedGapMs(h.store.list()),60000);
    assert.equal(h.monitor.twitchEventSubscribers.size,0);
  } finally {h.cleanup();}
});
test('YouTube uploads feed detects live stream immediately, never posts video simultaneously',async()=>{
  const h=setup([sub('youtube','maro','a')],{
    check:async()=>({live:false}),
    uploads:async()=>({activeLive:{live:true,id:'live-new',creator:'Maro',title:'Now live',platform:'YouTube',url:'https://youtube.com/watch?v=live-new'},
      allIds:['video-new'],videos:[{id:'video-new',publishedAt:'2026-10-31',url:'https://youtube.com/watch?v=video-new',title:'New upload'}]}),
  });
  try {
    await h.monitor.tick();
    assert.equal(h.posts.length,1);assert.match(h.posts[0].content,/live-new/);
    h.monitor.youtubeLastLiveCheck.clear();
    h.monitor.lastFeedChecks.clear();
    await h.monitor.tick();
    assert.equal(h.posts.length,1,'do not duplicate an active stream');
  } finally {h.cleanup();}
});
test('YouTube fanout: same creator tracked in two channels posts once to each, one remote request',async()=>{
  let queries=0;
  const h=setup([sub('youtube','maro','a'),sub('youtube','maro','b')],{
    check:async()=>({live:false}),
    uploads:async()=>{queries++;return {allIds:['video-new'],videos:[{
      id:'video-new',title:'Uploaded',publishedAt:'2026-10-31',url:'https://youtube.com/watch?v=video-new',platform:'YouTube',creator:'Maro'}]};},
  });
  try {
    await h.monitor.tick();
    assert.equal(h.posts.length,2);
    assert.equal(queries,1);
  } finally {h.cleanup();}
});
test('Twitch WebSocket notifications use stored subscription and persistent stream IDs', async()=>{
  const s=sub('twitch','maro','a','streams');
  const h=setup([s]);
  try {
    const ws=new TwitchSocket(h.monitor,h.store,{env:{TWITCH_CLIENT_ID:'fake'}});
    await ws.handleMessage(JSON.stringify({metadata:{message_type:'notification'},payload:{
      subscription:{type:'stream.online'},event:{id:'twitch-stream-1',broadcaster_user_login:'maro',broadcaster_user_name:'Maro'}
    }}));
    await ws.handleMessage(JSON.stringify({metadata:{message_type:'notification'},payload:{
      subscription:{type:'stream.online'},event:{id:'twitch-stream-1',broadcaster_user_login:'maro'}
    }}));
    assert.equal(h.posts.length,1);
    const persisted=new Store(h.dir);
    assert.deepEqual(persisted.find('g','a').seenStreamIds,['twitch-stream-1']);
  } finally {h.cleanup();}
});
test('TikTok post calls are throttled independent of fast live checks',async()=>{
  let live=0,feeds=0;
  const h=setup([sub('tiktok','creator','a')],{
    check:async()=>{live++;return {live:false}},
    uploads:async()=>{feeds++;return {allIds:[],videos:[]}},
  });
  try {
    await h.monitor.tick();await h.monitor.tick();
    assert.equal(live,1); assert.equal(feeds,1);
  } finally {h.cleanup();}
});
