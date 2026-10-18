import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { projectRoot } from '../scripts/build-source-examples.mjs';

const output = resolve(projectRoot, 'dist');
const artifacts = resolve(projectRoot, '.cache/docs-kit/browser-smoke');
await mkdir(artifacts, { recursive: true });
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = createServer(async (req, res) => {
  try {
    let path = resolve(output, '.' + decodeURIComponent(new URL(req.url, 'http://localhost').pathname));
    if (path !== output && !path.startsWith(output + '/')) throw new Error('Invalid path');
    if ((await stat(path)).isDirectory()) path = resolve(path, 'index.html');
    res.setHeader('Content-Type', types[extname(path)] ?? 'application/octet-stream');
    res.end(await readFile(path));
  } catch { res.statusCode = 404; res.end('Not found'); }
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const routes = [
  'modern-java/optional', 'concurrency/completablefuture', 'io-network/rest-vs-soap',
  'spring/dispatcher-servlet', 'spring/filter-va-interceptor', 'spring/spring-transaction',
  'jpa-hibernate/transactions-with-jpa', 'jvm/garbage-collection', 'collections/hashmap-deep-dive',
  'modern-java/virtual-threads', 'modern-java/stream-api', 'spring/access-control-models-rbac-acl',
];
const failures = [], checks = [];
try {
  for (const colorScheme of ['light', 'dark']) for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 960 }, colorScheme, permissions: ['clipboard-read', 'clipboard-write'], reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.on('pageerror', (error) => failures.push(error.message));
    page.on('response', (response) => { if (response.url().startsWith(base) && response.status() >= 400) failures.push(`${response.status()} ${response.url()}`); });
    // Font/catalog availability is not a prerequisite for exported documentation.
    await page.route('https://**/*', (route) => route.abort());
    for (const route of routes) {
      const response = await page.goto(`${base}/${route}/`, { waitUntil: 'networkidle' });
      assert.equal(response.status(), 200);
      await expect(page.locator('h1').first()).toBeVisible();
      const figures = page.locator('figure.d2-diagram');
      assert.ok(await figures.count() > 0, route);
      const visibleTheme = page.locator(`.d2-diagram-${colorScheme} svg`).first();
      await expect(visibleTheme).toBeVisible();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2), false, `Page-level overflow: ${route}, ${width}`);
      assert.equal(await page.locator('svg image[href^="https://icons.d2lang.com"]').count(), 0);
      if (route === 'modern-java/optional') {
        const walk = page.locator('.code-walkthrough');
        await walk.getByRole('button', { name: 'Bước sau', exact: true }).click();
        await expect(walk.locator('[data-line="2"]')).toHaveAttribute('data-highlighted', 'true');
        await walk.getByRole('button', { name: 'Sao chép code', exact: true }).click();
        assert.match(await page.evaluate(() => navigator.clipboard.readText()), /Optional\.ofNullable/);
        const diff = page.locator('.code-diff');
        await diff.getByRole('button', { name: 'Song song', exact: true }).click();
        await expect(diff).toHaveAttribute('data-view', 'split');
        await diff.getByRole('button', { name: 'Sao chép bản sau', exact: true }).click();
        assert.match(await page.evaluate(() => navigator.clipboard.readText()), /orElseGet/);
        await page.locator('.terminal-session').getByRole('button', { name: 'Sao chép lệnh bước 1', exact: true }).click();
        assert.match(await page.evaluate(() => navigator.clipboard.readText()), /jshell --feedback silent/);
        await walk.screenshot({ path: resolve(artifacts, `optional-${width}-${colorScheme}.png`) });
      }
      if (route === 'io-network/rest-vs-soap') {
        const exchange = page.locator('.protocol-exchange');
        await exchange.locator('[data-variant="missing"] summary').click();
        await expect(exchange.locator('[data-variant="missing"] .protocol-exchange-status-code')).toHaveText('404');
        await exchange.locator('[data-variant="missing"]').getByRole('button', { name: 'Sao chép response — User không tồn tại', exact: true }).click();
        assert.match(await page.evaluate(() => navigator.clipboard.readText()), /404/);
        await exchange.screenshot({ path: resolve(artifacts, `protocol-${width}-${colorScheme}.png`) });
      }
      if (route === 'concurrency/completablefuture') {
        const interactive = page.locator('.d2-interactive');
        await interactive.getByRole('button', { name: 'Explore diagram: allOf chờ cả hai future', exact: true }).click();
        await interactive.getByRole('button', { name: 'Next →', exact: true }).click();
        await expect(interactive.locator('.d2-step-count')).toHaveText('2 / 3');
        await interactive.getByRole('button', { name: 'Next →', exact: true }).click();
        await expect(interactive.locator('.d2-step-count')).toHaveText('3 / 3');
        await expect(interactive.getByRole('button', { name: 'Motion off', exact: true })).toBeDisabled();
        await interactive.getByRole('button', { name: 'Expand ↗', exact: true }).click();
        await expect(page.locator('dialog.d2-fullscreen')).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.locator('dialog.d2-fullscreen')).toHaveCount(0);
        const waterfall = page.locator('.span-waterfall');
        await waterfall.locator('[data-span="f1"] a').click();
        await expect(waterfall.locator('[data-detail="f1"]')).toHaveAttribute('open', '');
        await waterfall.screenshot({ path: resolve(artifacts, `waterfall-${width}-${colorScheme}.png`) });
      }
      if (route === 'spring/dispatcher-servlet') {
        const visual = page.locator('.d2-interactive').filter({ has: page.locator('figcaption').filter({ hasText: 'DispatcherServlet: kết quả controller và nhánh exception' }) });
        await visual.getByRole('button', { name: 'Explore diagram: DispatcherServlet: kết quả controller và nhánh exception', exact: true }).click();
        await visual.getByRole('button', { name: 'Fit', exact: true }).click();
        await expect(visual.locator('.d2-viewport')).toBeVisible();
        await visual.getByRole('button', { name: 'Copy D2', exact: true }).click();
        assert.match(await page.evaluate(() => navigator.clipboard.readText()), /postHandle\(\) theo thứ tự ngược/);
        await page.locator('.source-ref').first().click();
        await expect(page.locator('#source-explorer .source-code .line').first()).toBeVisible();
        await page.getByRole('button', { name: 'Copy file', exact: true }).click();
        assert.ok((await page.evaluate(() => navigator.clipboard.readText())).length > 30);
        await page.keyboard.press('Escape');
        await expect(page.locator('#source-explorer')).toHaveCount(0);
      }
      if (['spring/dispatcher-servlet', 'jpa-hibernate/transactions-with-jpa', 'jvm/garbage-collection'].includes(route)) {
        const caption = route === 'spring/dispatcher-servlet' ? 'DispatcherServlet: kết quả controller và nhánh exception'
          : route === 'jpa-hibernate/transactions-with-jpa' ? 'JPA: flush, commit hoặc rollback' : 'Young GC copy: đổi vai trò survivor spaces';
        await figures.filter({ hasText: caption }).screenshot({ path: resolve(artifacts, `${route.split('/').at(-1)}-${width}-${colorScheme}.png`) });
      }
      checks.push({ route, width, colorScheme, javascript: true });
    }
    await context.close();
  }
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 390, height: 960 } });
  const page = await context.newPage();
  await page.route('https://**/*', (route) => route.abort());
  for (const route of routes) {
    await page.goto(`${base}/${route}/`);
    await expect(page.locator('figure.d2-diagram svg').first()).toBeVisible();
    if (route === 'concurrency/completablefuture') {
      await page.locator('.d2-board-fallback summary').click();
      assert.equal(await page.locator('.d2-interactive figure.d2-diagram').count(), 3);
      await expect(page.locator('.span-waterfall')).toBeVisible();
    }
    if (route === 'modern-java/optional') {
      for (const selector of ['.code-diff', '.terminal-session', '.code-walkthrough']) await expect(page.locator(selector)).toBeVisible();
    }
    if (route === 'io-network/rest-vs-soap') {
      await page.locator('[data-variant="missing"] summary').click();
      await expect(page.locator('[data-variant="missing"] .protocol-exchange-status-code')).toHaveText('404');
    }
    if (route === 'spring/dispatcher-servlet') assert.match(await page.locator('.source-ref').first().getAttribute('href'), /source=dispatcher-servlet/);
    checks.push({ route, width: 390, javascript: false });
  }
  await context.close();
  assert.deepEqual(failures, [], 'Browser errors or missing local assets');
  await writeFile(resolve(artifacts, 'report.json'), JSON.stringify({ checks, failures }, null, 2) + '\n');
  console.log(`[browser-smoke] ${checks.length} route/theme/viewport/no-JS checks passed; artifacts: ${artifacts}`);
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
