import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';

export const commandDefinitions = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('تفعيل إنشاء الرومات المؤقتة تلقائيًا (للإدارة)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(o => o.setName('hub').setDescription('روم صوتية موجودة للإنشاء (اختياري)').addChannelTypes(ChannelType.GuildVoice).setRequired(false))
    .addChannelOption(o => o.setName('category').setDescription('تصنيف الرومات المؤقتة (اختياري)').addChannelTypes(ChannelType.GuildCategory).setRequired(false)),
  new SlashCommandBuilder()
    .setName('tempvoice')
    .setDescription('إعدادات نظام الرومات المؤقتة')
    .addSubcommand(s => s.setName('status').setDescription('عرض حالة النظام والرومات الحالية'))
    .addSubcommand(s => s.setName('disable').setDescription('إيقاف إنشاء رومات جديدة (للإدارة)')),
  new SlashCommandBuilder()
    .setName('panel')
    .setDescription('فتح لوحة التحكم لرومك الصوتية'),
  new SlashCommandBuilder()
    .setName('claim')
    .setDescription('استلام رومك إذا خرج مالكها'),
].map(b => b.toJSON());
