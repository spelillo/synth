import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listAllPaths, blocksDeletion } from '../api/delete-account.js';

function fakeStorage(tree) {
  return {
    storage: {
      from() {
        return {
          async list(prefix) {
            const node = prefix.split('/').reduce((n, k) => n && n[k], tree);
            return { data: Object.entries(node || {}).map(([name, v]) => ({ name, id: typeof v === 'object' ? null : 'file' })), error: null };
          },
        };
      },
    },
  };
}

test('lists every file under the user folder, through workspace folders', async () => {
  const sb = fakeStorage({ u1: { ws1: { 'a.csv': 1, 'b.csv': 1 }, ws2: { 'c.csv': 1 } } });
  assert.deepEqual((await listAllPaths(sb, 'u1')).sort(), ['u1/ws1/a.csv', 'u1/ws1/b.csv', 'u1/ws2/c.csv']);
  assert.deepEqual(await listAllPaths(sb, 'nobody'), []);
});

function fakeTables(rowsByTable, errorsByTable = {}) {
  return {
    from(table) {
      const q = { select: () => q, eq: () => q, limit: () => Promise.resolve(errorsByTable[table] ? { data: null, error: errorsByTable[table] } : { data: rowsByTable[table] || [], error: null }) };
      return q;
    },
  };
}

test('org admins, workroom managers and join-link creators are blocked', async () => {
  assert.equal(await blocksDeletion(fakeTables({}), 'u1'), false);
  assert.equal(await blocksDeletion(fakeTables({ org_members: [{ org_id: 'o' }] }), 'u1'), true);
  assert.equal(await blocksDeletion(fakeTables({ workrooms: [{ id: 'w' }] }), 'u1'), true);
  assert.equal(await blocksDeletion(fakeTables({ org_join_links: [{ id: 'l' }] }), 'u1'), true);
});

test('missing Enterprise tables do not block, other errors throw', async () => {
  const missing = { code: 'PGRST205', message: 'not found' };
  assert.equal(await blocksDeletion(fakeTables({}, { workrooms: missing, org_join_links: { code: '42P01', message: 'x' } }), 'u1'), false);
  await assert.rejects(blocksDeletion(fakeTables({}, { org_members: { code: '500', message: 'boom' } }), 'u1'), /boom/);
});
