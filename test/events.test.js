import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign, createHmac } from 'node:crypto';
import { EventBridge, parseYoutubeFeed, verifyKick, verifyTwitch } from '../src/events.js';

function subscription(platform, user, extra = {}) {
  return { guildId: 'guild', id: `${platform}-${user}`, platform, username: user, channelId: null,
    mode: 'both', destinationId: 'channel', initialized: true, uploadsInitialized: true, ...extra };
}
function env() { return { PUBLIC_BASE_URL: 'https://alerts.example.org', PORT: '0', TWITCH_WEBHOOK_SECRET: 'correct_horse_battery_staple', YOUTUBE_HUB_SECRET: 'ysecret' }; }
function mockBridge(subs) {
  const called = [];
  const store = { list: () => subs, find: (guildId, id) => subs.find(s => s.guildId === guildId && s.id === id) };
  const monitor = { process: async (...xs) => called.push(['stream', ...xs]), processUploads: async (...xs) => called.push(['video', ...xs]) };
  const bridge = new EventBridge(monitor, {}, store, { env: env() });
  return { bridge, called, store };
}
const xml = `<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015"><entry><yt:channelId>UC0000000000000000000000</yt:channelId><yt:videoId>aabbccdd123</yt:videoId></entry></feed>`;
test('YouTube Atom feed parses only proper IDs', () => {
  assert.deepEqual(parseYoutubeFeed(xml), [{channelId:'UC0000000000000000000000',videoId:'aabbccdd123'}]);
  assert.deepEqual(parseYoutubeFeed('<entry><yt:videoId>bad</yt:videoId></entry>'), []);
});
test('Twitch HMAC needs the genuine secret and fresh timestamp', () => {
  const ts = new Date().toISOString(), raw = '{}', secret = 'correct_horse_battery_staple';
  const msg = `abc${ts}${raw}`;
  const h = { 'twitch-eventsub-message-id': 'abc', 'twitch-eventsub-message-timestamp': ts,
    'twitch-eventsub-message-signature': 'sha256=' + createHmac('sha256', secret).update(msg).digest('hex') };
  assert.equal(verifyTwitch(h, raw, secret), true);
  assert.equal(verifyTwitch(h, raw + ' ', secret), false);
  assert.equal(verifyTwitch({...h, 'twitch-eventsub-message-timestamp': '2020-01-01T00:00:00Z' },raw,secret),false);
});
test('Kick webhook RSA signature validates and catches edits', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ts = new Date().toISOString(), raw = JSON.stringify({ is_live: true });
  const msg = `uuid.${ts}.${raw}`;
  const signature = createSign('RSA-SHA256').update(msg).end().sign(privateKey, 'base64');
  const h = { 'kick-event-message-id': 'uuid', 'kick-event-message-timestamp': ts, 'kick-event-signature': signature };
  assert.equal(verifyKick(h, raw, publicKey.export({type:'spki', format:'pem'})),true);
  assert.equal(verifyKick(h, raw + '.', publicKey.export({type:'spki', format:'pem'})),false);
});
test('Twitch event only notifies selected subscriptions', async () => {
  const { bridge, called } = mockBridge([subscription('twitch','maro'), subscription('twitch','other'), subscription('youtube','maro')]);
  await bridge.handleTwitchEvent({ id:'stream-8', broadcaster_user_login:'maro', broadcaster_user_name:'Maro',type:'live' });
  assert.equal(called.length,1);
  assert.equal(called[0][1].username,'maro');
  assert.equal(called[0][2].id,'stream-8');
});
test('Kick event accepts stream.on and stream.off, uses stable timestamp IDs', async () => {
  const { bridge, called } = mockBridge([subscription('kick','maro')]);
  const item = { broadcaster: { channel_slug: 'maro', username: 'Maro' }, is_live:true, title:'Go', started_at:'2026-10-31T12:00:00+03:00' };
  await bridge.handleKickEvent(item);
  assert.equal(called.length, 1);
  assert.equal(called[0][2].id, '2026-10-31T09:00:00.000Z');
  await bridge.handleKickEvent({ ...item, is_live: false });
  assert.equal(called[1][2].live, false);
});
test('YouTube upload event dispatch checks public status and creator ID', async () => {
  const channelId = 'UC0000000000000000000000';
  const { bridge, called } = mockBridge([subscription('youtube','maro',{channelId})]);
  bridge.env.YOUTUBE_API_KEY = 'test-key';
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok:true, json:async()=>({items:[{
      id:'aabbccdd123', snippet:{channelId,channelTitle:'Maro',liveBroadcastContent:'none',title:'New video',publishedAt:'2026-10-31T08:00:00Z'},status:{privacyStatus:'public'}
    }]}) });
    await bridge.handleYoutubeEntry({channelId, videoId:'aabbccdd123'});
    assert.equal(called.length,1);
    assert.equal(called[0][0],'video');
    assert.deepEqual(called[0][2].allIds,['aabbccdd123']);
    called.length=0;
    globalThis.fetch = async () => ({ok:true,json:async()=>({items:[{id:'aabbccdd123',snippet:{channelId,liveBroadcastContent:'none'},status:{privacyStatus:'private'}}]})});
    await bridge.handleYoutubeEntry({channelId, videoId:'aabbccdd123'});
    assert.equal(called.length,0);
  } finally { globalThis.fetch=original; }
});
test('YouTube live event takes precedence over upload and ignores scheduled broadcasts', async () => {
  const channelId = 'UC0000000000000000000000';
  const {bridge,called} = mockBridge([subscription('youtube','maro',{channelId})]);
  bridge.env.YOUTUBE_API_KEY='key';
  const old = globalThis.fetch;
  try {
    globalThis.fetch=async()=>({ok:true,json:async()=>({items:[{id:'aabbccdd123',snippet:{channelId,liveBroadcastContent:'live',title:'Stream'}, status:{privacyStatus:'public'},liveStreamingDetails:{actualStartTime:'2026-10-31T08:00:00Z'}}]})});
    await bridge.handleYoutubeEntry({channelId, videoId:'aabbccdd123'});
    assert.equal(called.length,1);
    assert.equal(called[0][0],'stream');
  } finally {globalThis.fetch=old;}
});
