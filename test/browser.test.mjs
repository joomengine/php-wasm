import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import * as playwright from 'playwright';
import { engineOptions, phpVersion, serve } from './helpers.mjs';

const browsers = (process.env.PHP_WASM_BROWSERS ?? 'chromium').split(',').map(name => name.trim()).filter(Boolean);

for (const browserName of browsers) {
  test(`${browserName}: PHP ${phpVersion} in a real browser worker`, { timeout: 240_000 }, async t => {
    assert.ok(['chromium', 'firefox', 'webkit'].includes(browserName), `Unknown browser ${browserName}`);
    const server = await serve();
    let browser;
    let context;
    t.after(async () => {
      try { await context?.close(); }
      finally {
        try { await browser?.close(); }
        finally { await server.close(); }
      }
    });
    const options = await engineOptions(server.url);
    const executablePath = process.env[`PHP_WASM_${browserName.toUpperCase()}_EXECUTABLE`];
    browser = await playwright[browserName].launch({ headless: true, ...(executablePath ? { executablePath } : {}), ...(browserName === 'chromium' ? { args: ['--no-sandbox'] } : {}) });
    context = await browser.newContext();
    const page = await context.newPage();
    const uncaught = [];
    page.on('pageerror', error => uncaught.push(error.message));
    await page.goto(server.url);

    await t.test('CLI and HTTP execute on a worker without cross-origin isolation', async () => {
      const result = await page.evaluate(async options => {
        const { createPHP } = await import('/src/index.mjs');
        const php = await createPHP(options);
        try {
          await php.fs.writeFile('/workspace/cli.php', '<?php echo json_encode([PHP_SAPI, $argv, stream_get_contents(STDIN)]);');
          const cli = await php.run({ script: '/workspace/cli.php', args: ['browser arg'], stdin: new TextEncoder().encode('browser input') });
          await php.fs.writeFile('/workspace/http.php', '<?php http_response_code(202); header("X-PHP-WASM: browser"); echo file_get_contents("php://input");');
          const http = await php.request({ script: '/workspace/http.php', url: 'https://example.test/example', method: 'POST', headers: [['content-type', 'application/octet-stream']], body: new Uint8Array([0, 255, 127, 128]) });
          return { isolated: crossOriginIsolated, cli: JSON.parse(new TextDecoder().decode(cli.stdout)), cliExit: cli.exitCode, http: { status: http.status, body: Array.from(http.body), headers: http.headers } };
        } finally { await php.close(); }
      }, options);
      assert.equal(result.isolated, false, 'The PHP runtime must work on ordinary static hosting without COOP/COEP headers');
      assert.equal(result.cliExit, 0);
      assert.deepEqual(result.cli, ['cli', ['/workspace/cli.php', 'browser arg'], 'browser input']);
      assert.equal(result.http.status, 202);
      assert.deepEqual(result.http.body, [0, 255, 127, 128]);
      assert.ok(result.http.headers.some(([key, value]) => key.toLowerCase() === 'x-php-wasm' && value === 'browser'));
    });

    await t.test('PHP Fibers can await browser host callbacks and return complete results', async () => {
      const result = await page.evaluate(async options => {
        const { createPHP } = await import('/src/index.mjs');
        const php = await createPHP({ ...options, hostCalls: {
          double: async payload => {
            await new Promise(resolve => setTimeout(resolve, 20));
            return JSON.stringify({ value: JSON.parse(payload).value * 2 });
          },
        } });
        try {
          await php.fs.writeFile('/workspace/async-fiber.php', `<?php
$fiber = new Fiber(function () {
  $result = json_decode(php_wasm_host_call('double', '{"value":21}'), true, 512, JSON_THROW_ON_ERROR);
  $resumed = Fiber::suspend($result['value']);
  return $resumed + 1;
});
$started = $fiber->start(); $fiber->resume(41);
echo json_encode([$started, $fiber->getReturn()], JSON_THROW_ON_ERROR);`);
          const first = await php.run({ script: '/workspace/async-fiber.php' });
          const repeated = await php.run({ script: '/workspace/async-fiber.php' });
          return [first, repeated].map(value => ({ exitCode: value.exitCode, output: new TextDecoder().decode(value.stdout), stderr: new TextDecoder().decode(value.stderr) }));
        } finally { await php.close(); }
      }, options);
      for (const value of result) {
        assert.equal(value.exitCode, 0, value.stderr);
        assert.deepEqual(JSON.parse(value.output), [42, 42]);
      }
    });

    await t.test('the page stays responsive while PHP is running', async () => {
      const result = await page.evaluate(async options => {
        const { createPHP } = await import('/src/index.mjs');
        const php = await createPHP(options);
        try {
          await php.fs.writeFile('/workspace/busy.php', '<?php $end = microtime(true) + 0.3; while (microtime(true) < $end) {} echo "done";');
          let ticks = 0;
          const interval = setInterval(() => { ticks++; }, 10);
          try {
            const response = await php.run({ script: '/workspace/busy.php' });
            return { ticks, output: new TextDecoder().decode(response.stdout), exitCode: response.exitCode };
          } finally { clearInterval(interval); }
        } finally { await php.close(); }
      }, options);
      assert.ok(result.ticks > 0, 'PHP must not block the page event loop');
      assert.equal(result.output, 'done');
      assert.equal(result.exitCode, 0);
    });

    await t.test('IndexedDB filesystem persists PHP writes across a page reload', async () => {
      const persistence = { key: `test-${randomUUID()}` };
      await page.evaluate(async ({ options, persistence }) => {
        const { createPHP } = await import('/src/index.mjs');
        const php = await createPHP({ ...options, persistence });
        await php.fs.writeFile('/workspace/persist.php', '<?php file_put_contents("/workspace/persisted.bin", "A\\0B\\xff"); echo "saved";');
        const result = await php.run({ script: '/workspace/persist.php' });
        if (result.exitCode !== 0 || new TextDecoder().decode(result.stdout) !== 'saved') throw new Error('PHP persistence fixture failed');
        await php.flush();
        await php.close();
      }, { options, persistence });
      await page.reload();
      const result = await page.evaluate(async ({ options, persistence }) => {
        const { createPHP } = await import('/src/index.mjs');
        const php = await createPHP({ ...options, persistence });
        try {
          return { bytes: Array.from(await php.fs.readFile('/workspace/persisted.bin')), names: await php.fs.readdir('/workspace') };
        } finally { await php.close(); }
      }, { options, persistence });
      assert.deepEqual(result.bytes, [65, 0, 66, 255]);
      assert.ok(result.names.includes('persist.php'));
    });

    await t.test('ephemeral workers have isolated filesystems', async () => {
      const result = await page.evaluate(async options => {
        const { createPHP } = await import('/src/index.mjs');
        const first = await createPHP(options);
        const second = await createPHP(options);
        try {
          await first.fs.writeFile('/workspace/private.txt', 'only first');
          let secondError;
          try { await second.fs.readFile('/workspace/private.txt'); } catch (error) { secondError = error.code; }
          return { first: new TextDecoder().decode(await first.fs.readFile('/workspace/private.txt')), secondError };
        } finally { await Promise.all([first.close(), second.close()]); }
      }, options);
      assert.equal(result.first, 'only first');
      assert.equal(result.secondError, 'FILESYSTEM_ERROR');
    });

    await t.test('a persistent filesystem cannot be opened for writing in two tabs', async () => {
      const persistence = { key: `lock-test-${randomUUID()}` };
      const competingPage = await context.newPage();
      try {
        await page.evaluate(async ({ options, persistence }) => {
          const { createPHP } = await import('/src/index.mjs');
          window.lockOwner = await createPHP({ ...options, persistence });
          await window.lockOwner.fs.writeFile('/workspace/owner.txt', 'owner state');
          await window.lockOwner.flush();
        }, { options, persistence });
        await competingPage.goto(server.url);
        const code = await competingPage.evaluate(async ({ options, persistence }) => {
          const { createPHP } = await import('/src/index.mjs');
          try {
            const php = await createPHP({ ...options, persistence });
            await php.close();
            return 'UNEXPECTED_SUCCESS';
          } catch (error) { return error.code; }
        }, { options, persistence });
        assert.equal(code, 'PERSISTENCE_IN_USE');
        await page.evaluate(async () => { await window.lockOwner.close(); delete window.lockOwner; });
        const stored = await competingPage.evaluate(async ({ options, persistence }) => {
          const { createPHP } = await import('/src/index.mjs');
          const php = await createPHP({ ...options, persistence });
          try { return new TextDecoder().decode(await php.fs.readFile('/workspace/owner.txt')); }
          finally { await php.close(); }
        }, { options, persistence });
        assert.equal(stored, 'owner state');
      } finally {
        await page.evaluate(async () => { await window.lockOwner?.close(); delete window.lockOwner; });
        await competingPage.close();
      }
    });

    assert.deepEqual(uncaught, [], 'Browser page must not emit uncaught errors');
  });
}
