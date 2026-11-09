/** One-time Twitch device authorization for outbound EventSub WebSocket.
 * Run interactively on the same hosting filesystem: npm run twitch:auth
 * Only the owner should approve the device code. Nothing is sent to Discord.
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
const clientId = process.env.TWITCH_CLIENT_ID;
if (!clientId) { console.error('TWITCH_CLIENT_ID is missing'); process.exit(1); }
const post = async (url, body) => {
  const res = await fetch(url, { method:'POST', body:new URLSearchParams(body), signal:AbortSignal.timeout(15000) });
  const data = await res.json().catch(() => ({}));
  return { res, data };
};
const { res, data } = await post('https://id.twitch.tv/oauth2/device', { client_id:clientId, scopes:'' });
if (!res.ok || !data.device_code) {
  console.error(`Twitch device authorization failed: HTTP ${res.status}`, data.message || '');
  process.exit(1);
}
console.log('\n[TWITCH AUTH] Open this link and enter the one-time code to authorize your bot:');
console.log(data.verification_uri);
console.log('Code:', data.user_code, '\n');
console.log('Do not share access tokens, secrets, or your saved JSON file.');
let delay = Math.max(5, Number(data.interval || 5)) * 1000;
const deadline = Date.now() + Math.min(Number(data.expires_in || 600) * 1000, 900_000);
let success = false;
while (Date.now() < deadline) {
  await new Promise(r => setTimeout(r, delay));
  const reply = await post('https://id.twitch.tv/oauth2/token', {
    client_id:clientId, device_code:data.device_code,
    grant_type:'urn:ietf:params:oauth:grant-type:device_code',
  });
  if (reply.res.ok && reply.data.access_token && reply.data.refresh_token) {
    const file = path.join(process.env.DATA_DIR || './data', 'twitch-oauth.json');
    fs.mkdirSync(path.dirname(file), {recursive:true});
    fs.writeFileSync(file, JSON.stringify({ access_token:reply.data.access_token, refresh_token:reply.data.refresh_token },null,2),{mode:0o600});
    console.log('[TWITCH AUTH] Saved user token privately to', file);
    console.log('Restore normal startup command and restart MG3.');
    success = true;
    break;
  }
  const error = reply.data.message || reply.data.error || '';
  if (/slow_down/i.test(error)) { delay += 5000; continue; }
  if (/authorization_pending|pending/i.test(error)) continue;
  console.error('[TWITCH AUTH] Failed:', error, `(HTTP ${reply.res.status})`);
  break;
}
if (!success) { console.error('[TWITCH AUTH] Authorization not completed.'); process.exitCode = 1; }
