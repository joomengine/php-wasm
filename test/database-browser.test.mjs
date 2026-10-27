import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import * as playwright from 'playwright';
import { clearDatabaseReceipt, recordDatabaseReceipt } from '../scripts/database-test-receipt.mjs';
import { databaseFixture, serveDatabase } from './database-helpers.mjs';
import { engineOptions, phpVersion } from './helpers.mjs';

const browsers = (process.env.PHP_WASM_BROWSERS ?? 'chromium').split(',').map(name => name.trim()).filter(Boolean);

for (const browserName of browsers) {
  test(`${browserName}: PHP ${phpVersion} PDO and MariaDB WASM with persisted SQL`, { timeout: 300_000 }, async () => {
    assert.ok(['chromium', 'firefox'].includes(browserName), `Unsupported database browser ${browserName}`);
    await clearDatabaseReceipt(browserName);
    const server = await serveDatabase();
    let browser;
    let context;
    try {
      const options = await engineOptions(server.url);
      const executablePath = process.env[`PHP_WASM_${browserName.toUpperCase()}_EXECUTABLE`];
      browser = await playwright[browserName].launch({ headless: true, ...(executablePath ? { executablePath } : {}), ...(browserName === 'chromium' ? { args: ['--no-sandbox'] } : {}) });
      context = await browser.newContext();
      const page = await context.newPage();
      const uncaught = [];
      page.on('pageerror', error => uncaught.push(error.message));
      await page.goto(server.url);
      const persistence = { key: `php-pdo-${randomUUID()}` };
      const result = await page.evaluate(async ({ options, persistence, fixture }) => {
        const { createPHP } = await import('/src/index.mjs');
        const { createMariaDB } = await import('/mariadb/src/index.mjs');
        const db = await createMariaDB({ database: 'joomla', persistence, engineModuleUrl: new URL('/mariadb/vendor/lite4mariadb/index.mjs', location.href).href });
        const operations = [];
        let php;
        let ticks = 0;
        const interval = setInterval(() => { ticks++; }, 10);
        const decode = value => new TextDecoder().decode(value);
        try {
          php = await createPHP({ ...options, hostCalls: {
            'mariadb.v1': async payload => {
              operations.push(JSON.parse(payload).op);
              return db.hostCalls['mariadb.v1'](payload);
            },
          } });
          await php.fs.writeFile('/workspace/database.php', fixture);
          const run = DATABASE_CASE => php.run({ script: '/workspace/database.php', env: { DATABASE_CASE }, ini: { display_errors: 'stderr' } });
          const contract = await run('contract');
          if (contract.exitCode !== 0) throw new Error(`PDO contract failed: ${decode(contract.stderr)}`);
          const summary = JSON.parse(decode(contract.stdout));
          const contractCloses = operations.filter(op => op === 'close').length;
          const seeded = await run('seed');
          if (seeded.exitCode !== 0 || decode(seeded.stdout) !== 'seeded') throw new Error(`SQL seed failed: ${decode(seeded.stderr)}`);
          const cleanup = [];
          for (const mode of ['return', 'exit', 'fatal']) {
            const abandoned = await run(mode);
            const next = await run('check');
            if (next.exitCode !== 0) throw new Error(`PDO reconnect after ${mode} failed: ${decode(next.stderr)}`);
            cleanup.push({ mode, exitCode: abandoned.exitCode, stdout: decode(abandoned.stdout), stderr: decode(abandoned.stderr), rows: JSON.parse(decode(next.stdout)) });
          }
          const http = await php.request({ script: '/workspace/database.php', url: 'https://playground.test/database', env: { DATABASE_CASE: 'check' } });
          if (http.exitCode !== 0) throw new Error(`PHP HTTP database request failed: ${decode(http.stderr)}`);
          await db.flush();
          return { isolated: crossOriginIsolated, summary, contractCloses, queryCount: operations.filter(op => op === 'query').length, cleanup, httpStatus: http.status, httpRows: JSON.parse(decode(http.body)), ticks };
        } finally {
          clearInterval(interval);
          try { await php?.close(); }
          finally { await db.close(); }
        }
      }, { options, persistence, fixture: databaseFixture });
      assert.equal(result.isolated, true);
      assert.ok(result.summary.assertions >= 22);
      assert.equal(result.summary.integerSize, 4);
      assert.match(result.summary.server, /MariaDB/);
      assert.equal(result.contractCloses, 1, 'The PDO destructor awaits its bridge close during PHP shutdown');
      assert.ok(result.queryCount >= 25);
      assert.ok(result.ticks > 0, 'The page remains responsive during combined WASM execution');
      for (const item of result.cleanup) {
        if (item.mode === 'fatal') {
          assert.notEqual(item.exitCode, 0);
          assert.match(item.stderr, /database fixture intentional fatal/);
        } else {
          assert.equal(item.exitCode, item.mode === 'exit' ? 17 : 0, item.stderr);
          assert.deepEqual(JSON.parse(item.stdout), { transaction: true });
        }
        assert.deepEqual(item.rows, ['committed'], `${item.mode} must release the PDO lease and roll back`);
      }
      assert.equal(result.httpStatus, 200);
      assert.deepEqual(result.httpRows, ['committed']);

      // Reopen both workers after a real page reload. Only MariaDB persistence
      // carries the table over; the new PHP filesystem is deliberately empty.
      await page.reload();
      const restored = await page.evaluate(async ({ options, persistence, fixture }) => {
        const { createPHP } = await import('/src/index.mjs');
        const { createMariaDB } = await import('/mariadb/src/index.mjs');
        const db = await createMariaDB({ database: 'joomla', persistence, engineModuleUrl: new URL('/mariadb/vendor/lite4mariadb/index.mjs', location.href).href });
        let php;
        try {
          php = await createPHP({ ...options, hostCalls: db.hostCalls });
          await php.fs.writeFile('/workspace/database.php', fixture);
          const result = await php.run({ script: '/workspace/database.php', env: { DATABASE_CASE: 'check' } });
          return { exitCode: result.exitCode, stderr: new TextDecoder().decode(result.stderr), output: new TextDecoder().decode(result.stdout) };
        } finally {
          try { await php?.close(); }
          finally { await db.close(); }
        }
      }, { options, persistence, fixture: databaseFixture });
      assert.equal(restored.exitCode, 0, restored.stderr);
      assert.deepEqual(JSON.parse(restored.output), ['committed'], 'PDO reads the committed table from IndexedDB after reload');
      assert.deepEqual(uncaught, [], 'Both WASM workers complete without uncaught page errors');
    } finally {
      try { await context?.close(); }
      finally {
        try { await browser?.close(); }
        finally { await server.close(); }
      }
    }
    await recordDatabaseReceipt(browserName);
  });
}
