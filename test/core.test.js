import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StateStore } from '../src/store.js';
import { cleanRoomName, parseUserLimit, isOwnerPresent } from '../src/utils.js';

test('cleans room names and protects limits', () => {
  assert.equal(cleanRoomName('  Hello\nWorld  '), 'HelloWorld');
  assert.equal(cleanRoomName('a'.repeat(120)).length, 80);
  assert.equal(parseUserLimit('0'), 0);
  assert.equal(parseUserLimit('99'), 99);
  assert.equal(parseUserLimit('100'), null);
  assert.equal(parseUserLimit('2.5'), null);
  assert.equal(parseUserLimit('-1'), null);
  assert.equal(parseUserLimit('foo'), null);
});

test('tracks presence of rightful owner', () => {
  assert.equal(isOwnerPresent({ ownerId: '2' }, [{ id: '1', user: { bot: false } }, { id: '2', user: { bot: false } }]), true);
  assert.equal(isOwnerPresent({ ownerId: '2' }, [{ id: '1', user: { bot: false } }]), false);
});

test('persists guild configs and room ownership across restart', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'tempvoice-test-'));
  try {
    const file = path.join(folder, 'nested', 'state.json');
    const store = new StateStore(file);
    store.setConfig('guild', { hubId: 'hub', categoryId: 'category' });
    store.setRoom('chan', { guildId: 'guild', ownerId: 'alice', locked: false, hidden: false });
    assert.equal(store.roomOwnedBy('guild', 'alice')[0], 'chan');
    store.patchRoom('chan', { ownerId: 'bob', locked: true });
    const recovered = new StateStore(file);
    assert.equal(recovered.config('guild').hubId, 'hub');
    assert.equal(recovered.room('chan').ownerId, 'bob');
    assert.equal(recovered.room('chan').locked, true);
    assert.equal(readFileSync(file, 'utf8').includes('"schema": 1'), true);
    recovered.deleteRoom('chan');
    assert.equal(new StateStore(file).room('chan'), null);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
