import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

test('a newly initialized fresh bot has zero subscriptions and no prior history', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg3-fresh-'));
  try {
    const store = new Store(dir);
    assert.deepEqual(store.list(), []);
    assert.equal(fs.existsSync(path.join(dir, 'alerts.json')), false);
    store.add({ guildId:'test', id:'fresh', platform:'youtube', seenStreamIds: [] });
    const restored = new Store(dir);
    assert.equal(restored.list().length, 1);
    assert.deepEqual(restored.list()[0].seenStreamIds, []);
  } finally { fs.rmSync(dir, {recursive:true, force:true}); }
});
