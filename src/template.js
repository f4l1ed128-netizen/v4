export const DEFAULT_TEMPLATE = '🔴 **{creator}** started a new stream on **{platform}**! {ping}\n🎬 **{title}**\n🔗 {url}';
export const DEFAULT_VIDEO_TEMPLATE = '🎬 **{creator}** uploaded a new video! {ping}\n📺 **{title}**\n🔗 {url}';
const escapeEveryone = text => text.replace(/@/g, '@\u200b').replace(/<@/g, '<@\u200b');
export function renderTemplate(template, info, pingMode = 'none', roleId = null) {
  let ping = '';
  if (pingMode === 'everyone') ping = '@everyone';
  if (pingMode === 'here') ping = '@here';
  if (pingMode === 'role' && roleId) ping = `<@&${roleId}>`;
  // Treat remote stream titles and creator names as untrusted, non-mentionable text.
  const replacements = {
    creator: escapeEveryone(info.creator ?? 'Creator'),
    platform: escapeEveryone(info.platform ?? 'Unknown'),
    title: escapeEveryone(info.title ?? 'Live now'),
    url: info.url ?? '',
    viewers: String(info.viewers ?? '?'),
    ping,
  };
  const output = String(template || DEFAULT_TEMPLATE).replace(/\{(creator|platform|title|url|viewers|ping)\}/gi,
    (_, key) => replacements[key.toLowerCase()] ?? '');
  return output.slice(0, 1900);
}
export function mentionOptions(mode = 'none', roleId = null) {
  return {
    parse: mode === 'everyone' || mode === 'here' ? ['everyone'] : [],
    users: [],
    roles: mode === 'role' && roleId ? [roleId] : [],
    repliedUser: false,
  };
}
export function buildAlertPayload(subscription, info, test = false, kind = 'stream') {
  const video = kind === 'video';
  const template = video ? (subscription.videoTemplate || DEFAULT_VIDEO_TEMPLATE) : subscription.template;
  const pingMode = video ? (subscription.videoPingMode ?? 'none') : subscription.pingMode;
  const roleId = video ? (subscription.videoRoleId ?? null) : subscription.roleId;
  let content = renderTemplate(template, info, pingMode, roleId);
  if (test) content = `🧪 **TEST ALERT**\n${content}`;
  return { content, allowedMentions: mentionOptions(pingMode, roleId),
    // Keep native link previews. All fields are customizable in content.
  };
}
