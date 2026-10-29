/** Pure helpers for safe TempVoice cleanup and dashboard de-duplication. */
export function hasHumanVoiceMembers(channel) {
  const states = channel.guild.voiceStates.cache;
  return states.some(state => {
    if (state.channelId !== channel.id) return false;
    const user = state.member?.user || channel.guild.members.cache.get(state.id)?.user;
    return !user?.bot;
  });
}

export function isTempVoicePanel(message, channelId, botId) {
  if (message?.author?.id !== botId) return false;
  return (message.components || []).some(row =>
    (row.components || []).some(button =>
      (button.customId || button.custom_id || '').startsWith(`tv:${channelId}:`)));
}

export function preferredPanel(messages, storedId) {
  return messages.find(message => message.id === storedId) ||
    [...messages].sort((a, b) => (b.createdTimestamp || 0) - (a.createdTimestamp || 0))[0] || null;
}
