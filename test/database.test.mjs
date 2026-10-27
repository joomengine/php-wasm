import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPHP } from '../src/index.mjs';
import { clearDatabaseReceipt, recordDatabaseReceipt } from '../scripts/database-test-receipt.mjs';
import { databaseFixture, loadMariaDB } from './database-helpers.mjs';
import { decode, engineOptions, phpVersion } from './helpers.mjs';

test(`PHP ${phpVersion}: native PDO and real MariaDB WebAssembly through Asyncify`, { timeout: 240_000 }, async () => {
  await clearDatabaseReceipt('node');
  const { createMariaDB } = await loadMariaDB();
  const db = await createMariaDB({ database: 'joomla' });
  const operations = [];
  const hostCalls = {
    'mariadb.v1': async payload => {
      operations.push(JSON.parse(payload).op);
      return db.hostCalls['mariadb.v1'](payload);
    },
  };
  const options = await engineOptions();
  let php;
  try {
    php = await createPHP({ ...options, hostCalls });
    await php.fs.writeFile('/workspace/database.php', databaseFixture);
    const run = DATABASE_CASE => php.run({ script: '/workspace/database.php', env: { DATABASE_CASE }, ini: { display_errors: 'stderr' } });
    const contract = await run('contract');
    assert.equal(contract.exitCode, 0, decode(contract.stderr));
    const summary = JSON.parse(decode(contract.stdout));
    assert.ok(summary.assertions >= 22, 'All PHP-side PDO and SQL assertions completed');
    assert.equal(summary.integerSize, 4);
    assert.match(summary.server, /MariaDB/);
    assert.ok(operations.filter(op => op === 'query').length >= 25, 'Actual SQL crosses asynchronous worker boundaries');
    assert.equal(operations.filter(op => op === 'close').length, 1, 'Request shutdown closes the live PDO connection asynchronously');

    assert.equal(decode((await run('seed')).stdout), 'seeded');
    for (const mode of ['return', 'exit', 'fatal']) {
      const result = await run(mode);
      if (mode === 'fatal') {
        assert.notEqual(result.exitCode, 0);
        assert.match(decode(result.stderr), /database fixture intentional fatal/);
      } else {
        assert.equal(result.exitCode, mode === 'exit' ? 17 : 0, decode(result.stderr));
        assert.deepEqual(JSON.parse(decode(result.stdout)), { transaction: true });
      }
      const next = await run('check');
      assert.equal(next.exitCode, 0, `A new PDO connection must work after ${mode}: ${decode(next.stderr)}`);
      assert.deepEqual(JSON.parse(decode(next.stdout)), ['committed'], `The ${mode} request must roll back its abandoned transaction`);
    }

    const http = await php.request({ script: '/workspace/database.php', url: 'https://playground.test/database', env: { DATABASE_CASE: 'check' } });
    assert.equal(http.exitCode, 0, decode(http.stderr));
    assert.equal(http.status, 200);
    assert.deepEqual(JSON.parse(decode(http.body)), ['committed']);
    await php.close();

    // A killed PHP worker cannot execute destructors. The embedding application
    // must explicitly reset the bridge before replacing that PHP worker.
    let enteredTransaction = false;
    php = await createPHP({ ...options, timeoutMs: 2_000, hostCalls: {
      ...hostCalls,
      'database.timeout-ready': async () => { enteredTransaction = true; return ''; },
    } });
    await php.fs.writeFile('/workspace/database.php', databaseFixture);
    await assert.rejects(php.run({ script: '/workspace/database.php', env: { DATABASE_CASE: 'timeout' } }), error => error.code === 'TIMEOUT');
    assert.equal(enteredTransaction, true, 'PHP reached the loop after beginning a real database transaction');
    assert.equal(php.state, 'closed');
    assert.equal(db.state, 'ready');
    await db.reset();
    await php.close();
    php = await createPHP({ ...options, hostCalls });
    await php.fs.writeFile('/workspace/database.php', databaseFixture);
    const recovered = await php.run({ script: '/workspace/database.php', env: { DATABASE_CASE: 'check' } });
    assert.equal(recovered.exitCode, 0, decode(recovered.stderr));
    assert.deepEqual(JSON.parse(decode(recovered.stdout)), ['committed'], 'Reset releases the abandoned lease and rolls back the terminated PHP transaction');
  } finally {
    try { await php?.close(); }
    finally { await db.close(); }
  }
  await recordDatabaseReceipt('node');
});
