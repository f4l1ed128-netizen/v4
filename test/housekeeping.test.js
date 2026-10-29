import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasHumanVoiceMembers, isTempVoicePanel, preferredPanel } from '../src/housekeeping.js';

function channel(states) {
  return {
    id: 'voice1',
    guild: {
      voiceStates: { cache: { some: predicate => states.some(predicate) } },
      members: { cache: new Map() },
    },
  };
}

test('empty voice room can be cleaned up, ignoring bot members', () => {
  assert.equal(hasHumanVoiceMembers(channel([])), false);
  assert.equal(hasHumanVoiceMembers(channel([
    { id: 'musicbot', channelId: 'voice1', member: { user: { bot: true } } },
  ])), false);
  assert.equal(hasHumanVoiceMembers(channel([
    { id: 'human', channelId: 'voice1', member: { user: { bot: false } } },
  ])), true);
  assert.equal(hasHumanVoiceMembers(channel([
    { id: 'human', channelId: 'other', member: { user: { bot: false } } },
  ])), false);
});

test('recognizes only this bot’s actual dashboard messages', () => {
  const panel = { author: { id: 'bot' }, components: [{ components: [{ customId: 'tv:voice1:rename' }] }] };
  assert.equal(isTempVoicePanel(panel, 'voice1', 'bot'), true);
  assert.equal(isTempVoicePanel(panel, 'voice2', 'bot'), false);
  assert.equal(isTempVoicePanel(panel, 'voice1', 'otherbot'), false);
});

test('selects the stored panel first or the most recent one when recovering', () => {
  const msgs = [
    { id: 'old', createdTimestamp: 10 },
    { id: 'new', createdTimestamp: 20 },
  ];
  assert.equal(preferredPanel(msgs, 'old').id, 'old');
  assert.equal(preferredPanel(msgs, 'missing').id, 'new');
  assert.equal(preferredPanel([], null), null);
});
