import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder,
  StringSelectMenuBuilder, UserSelectMenuBuilder,
} from 'discord.js';
import { fileURLToPath } from 'node:url';

export const COLOR = 0x28282f;
const actionId = (channelId, action) => `tv:${channelId}:${action}`;
const asset = name => fileURLToPath(new URL(`../assets/${name}`, import.meta.url));
const PANEL_IMAGE = asset('tempvoice-panel.png');

// Same order as the 5x3 buttons in the supplied reference screenshot.
export const PANEL_ACTIONS = [
  [
    { action: 'rename', emoji: '🪧', name: 'تغيير الاسم' },
    { action: 'limit', emoji: '👥', name: 'حد الأعضاء' },
    { action: 'kick', emoji: '🔨', name: 'طرد عضو' },
    { action: 'transfer', emoji: '👑', name: 'تغيير المالك' },
    { action: 'delete', emoji: '🗑️', name: 'حذف الروم' },
  ],
  [
    { action: 'lock', emoji: '🔇', name: 'قفل الروم' },
    { action: 'unlock', emoji: '🔊', name: 'فتح الروم' },
    { action: 'hide', emoji: '🙈', name: 'إخفاء الروم' },
    { action: 'reveal', emoji: '👁️', name: 'إظهار الروم' },
    { action: 'region', emoji: '🌍', name: 'تغيير الريجن' },
  ],
  [
    { action: 'mute', emoji: '🎙️', name: 'ميوت عضو' },
    { action: 'unmute', emoji: '🎤', name: 'فك الميوت' },
    { action: 'block', emoji: '🚫', name: 'منع عضو' },
    { action: 'permit', emoji: '✅', name: 'سماح لعضو' },
    { action: 'invite', emoji: '🔗', name: 'دعوة عضو' },
  ],
];

const remoteIcons = new Map();
const iconNames = Object.fromEntries(
  PANEL_ACTIONS.flat().map((item, i) => [item.action, `tempo_v4_${String(i + 1).padStart(2, '0')}`]),
);

// One-time automatic setup of application emojis, where Discord permits it.
// The built-in emojis above remain working fallbacks if uploads are unavailable.
export async function initializePanelEmojis(application) {
  if (process.env.TEMPO_CUSTOM_EMOJIS === 'false') return 0;
  let available;
  try { available = await application.emojis.fetch(); }
  catch (err) {
    console.warn('[TEMPO] Application emoji access unavailable, using standard emojis:', err.message);
    return 0;
  }
  let created = 0;
  for (const [index, item] of PANEL_ACTIONS.flat().entries()) {
    const name = iconNames[item.action];
    let emoji = available.find(e => e.name === name);
    if (!emoji) {
      try {
        emoji = await application.emojis.create({ name, attachment: asset(`icon-${String(index + 1).padStart(2, '0')}.png`) });
        created += 1;
      } catch (err) {
        console.warn(`[TEMPO] Custom icon ${name} unavailable: ${err.message}`);
        continue;
      }
    }
    remoteIcons.set(item.action, { id: emoji.id, name: emoji.name });
  }
  console.log(`[TEMPO] ${remoteIcons.size}/15 reference-style button icons ready (${created} uploaded).`);
  return remoteIcons.size;
}

const btn = (channelId, { action, emoji }) => new ButtonBuilder()
  .setCustomId(actionId(channelId, action))
  .setStyle(ButtonStyle.Secondary) // Reference has 15 identical grey buttons.
  .setEmoji(remoteIcons.get(action) ?? emoji);

// The graphic matches the reference: no extra owner/status fields, exactly the
// screenshot's title, Arabic sentence and labeled control legend in the image.
// The real clickable buttons are separate Discord interaction components.
export function dashboard(channel) {
  const components = PANEL_ACTIONS.map(row => new ActionRowBuilder().addComponents(
    ...row.map(item => btn(channel.id, item)),
  ));
  return {
    content: '', embeds: [],
    files: [new AttachmentBuilder(PANEL_IMAGE, { name: 'tempvoice-panel.png', description: 'لوحة تحكم الروم الصوتي' })],
    components,
    allowedMentions: { parse: [] },
  };
}

export function userPicker(channelId, action) {
  const descriptions = {
    permit: ['✅ السماح لعضو', 'اختر عضوًا للسماح له بالدخول حتى لو كانت الروم مقفلة أو مخفية.'],
    block: ['🚫 منع عضو', 'اختر عضوًا لمنعه من الدخول وطرده إذا كان متصلًا بالروم.'],
    kick: ['🔨 طرد عضو', 'اختر أحد الموجودين في الروم لطرده دون منعه من العودة.'],
    transfer: ['👑 تغيير المالك', 'اختر مالكًا جديدًا من الأعضاء الموجودين داخل الروم.'],
    mute: ['🔕 ميوت عضو', 'اختر عضوًا متصلًا بالروم لكتم المايك من السيرفر.'],
    unmute: ['🎤 فك الميوت', 'اختر عضوًا كتمته لوحة التحكم لفك الميوت عنه.'],
    invite: ['🔗 دعوة عضو', 'اختر عضوًا من السيرفر لإرسال دعوة خاصة إلى الروم.'],
  };
  const [title, desc] = descriptions[action];
  return {
    embeds: [new EmbedBuilder().setColor(COLOR).setTitle(title).setDescription(desc)],
    components: [new ActionRowBuilder().addComponents(
      new UserSelectMenuBuilder().setCustomId(actionId(channelId, `pick_${action}`))
        .setPlaceholder('اختر عضوًا من السيرفر...').setMinValues(1).setMaxValues(1),
    )],
  };
}

export function regionPicker(channelId, current) {
  const options = [
    ['تلقائي (أفضل اتصال)', 'auto'], ['أوروبا', 'rotterdam'],
    ['أمريكا - شرق', 'us-east'], ['أمريكا - غرب', 'us-west'],
    ['أمريكا - وسط', 'us-central'], ['البرازيل', 'brazil'],
    ['سنغافورة', 'singapore'], ['اليابان', 'japan'],
    ['الهند', 'india'], ['هونغ كونغ', 'hongkong'],
    ['سيدني', 'sydney'], ['جنوب أفريقيا', 'southafrica'],
  ];
  const menu = new StringSelectMenuBuilder()
    .setCustomId(actionId(channelId, 'pick_region'))
    .setPlaceholder('اختر منطقة الاتصال الصوتي')
    .addOptions(options.map(([label, value]) => ({ label, value, default: value === (current || 'auto') })));
  return {
    embeds: [new EmbedBuilder().setColor(COLOR).setTitle('🌍 تغيير الريجن')
      .setDescription('اختر المنطقة، أو اختر **تلقائي** ليحدد ديسكورد أفضل سيرفر.')],
    components: [new ActionRowBuilder().addComponents(menu)],
  };
}

export function confirmDelete(channelId) {
  return {
    content: '⚠️ **متأكد من حذف الروم؟** جميع الموجودين فيها رح ينفصلوا، وما بتقدر ترجعها.',
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(actionId(channelId, 'delete_yes')).setLabel('نعم، احذف الروم').setEmoji('🗑️').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(actionId(channelId, 'delete_no')).setLabel('إلغاء').setStyle(ButtonStyle.Secondary),
    )],
  };
}
