import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { unified } from 'unified';
import { visit } from 'unist-util-visit';
import { parse, stringify } from 'yaml';
import { readDocuments, projectRoot } from '../scripts/build-source-examples.mjs';
import { learningPlugins } from '../scripts/learning-plugins.mjs';
import { checkInventory, inventoryCandidates, digest } from '../scripts/diagram-inventory.mjs';

const documents = await readDocuments(resolve(projectRoot, 'content/docs'));
const descriptors = new Map();
for (const document of documents) visit(document.tree, 'code', (node) => {
  if (['code-walkthrough', 'code-diff', 'terminal-session', 'protocol-exchange', 'span-waterfall'].includes(node.lang)) {
    descriptors.set(node.lang, { node, path: resolve(projectRoot, 'content/docs', document.path) });
  }
});
const expected = {
  'code-walkthrough': 'CodeWalkthrough', 'code-diff': 'CodeDiff',
  'terminal-session': 'TerminalSession', 'protocol-exchange': 'ProtocolExchange',
  'span-waterfall': 'SpanWaterfall',
};

test('all documentation text/visual candidates are reviewed; Mermaid and edited text fail closed', async () => {
  const result = await checkInventory(documents);
  assert.equal(result.pages, 88);
  assert.equal(result.reviewedText, 311);
  assert.equal(result.converted, 155);
  const changed = structuredClone(documents);
  const first = inventoryCandidates(changed)[0];
  visit(changed.find((doc) => doc.path === first.path).tree, 'code', (node) => {
    if (digest(node.value) === first.sha256) node.value += '\nnew unreviewed diagram';
  });
  await assert.rejects(checkInventory(changed), /Unreviewed text\/visual/);
  const legacy = structuredClone(documents);
  legacy[0].tree.children.push({ type: 'code', lang: 'mermaid', value: 'flowchart LR\na --> b', position: { start: { line: 1 }, end: { line: 1 } } });
  await assert.rejects(checkInventory(legacy), /Mermaid:/);
});

test('docs-kit stays pinned to installed 0.9.8 and every learning fence has plugin, component and CSS', async () => {
  const manifest = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf8'));
  const installed = JSON.parse(await readFile(resolve(projectRoot, 'node_modules/@vanhiep99w/docs-kit/package.json'), 'utf8'));
  assert.equal(manifest.dependencies['@vanhiep99w/docs-kit'], '0.9.8');
  assert.equal(installed.version, '0.9.8');
  const registry = await readFile(resolve(projectRoot, 'src/app/[[...slug]]/page.tsx'), 'utf8');
  const css = await readFile(resolve(projectRoot, 'src/app/globals.css'), 'utf8');
  assert.equal(descriptors.size, 5);
  for (const [fence, component] of Object.entries(expected)) {
    assert.ok(registry.includes(`, ${component}`));
    assert.ok(css.includes(`/styles/${fence}.css`));
    const fixture = descriptors.get(fence);
    const tree = await unified().use(learningPlugins).run({ type: 'root', children: [structuredClone(fixture.node)] }, { path: fixture.path });
    assert.equal(tree.children[0].name, component, fence);
  }
});

for (const [fence, mutate] of Object.entries({
  'code-walkthrough': (data) => { data.steps[0].ranges = [[999, 1000]]; },
  'code-diff': (data) => { data.after.code = 42; },
  'terminal-session': (data) => { data.context.kind = 'unknown'; },
  'protocol-exchange': (data) => { data.variants[0].response.body.json = '{"id":'; },
  'span-waterfall': (data) => { data.spans[1].parent = 'unknown-parent'; },
})) test(`${fence} rejects malformed authored descriptors`, async () => {
  const fixture = descriptors.get(fence);
  const data = parse(fixture.node.value);
  mutate(data);
  const node = { ...fixture.node, value: stringify(data) };
  await assert.rejects(unified().use(learningPlugins).run({ type: 'root', children: [node] }, { path: fixture.path }));
});

test('trusted Java icon matches catalog checksum and has no active or linked resources', async () => {
  const svg = await readFile(resolve(projectRoot, 'content/assets/d2/java.svg'), 'utf8');
  assert.equal(digest(svg), 'a6f65d8842fd38a48c7daaa646d3ee56ee22e6b09bf32316ee45f845c6ee63af');
  assert.doesNotMatch(svg, /<script|<foreignObject|\bon\w+=|(?:href|src)=/i);
});

test('MVC success and exception branches do not both invoke postHandle', () => {
  for (const path of ['spring/dispatcher-servlet.md', 'spring/filter-va-interceptor.md']) {
    const source = documents.find((document) => document.path === path).value;
    const failure = source.match(/fail: "Controller ném exception[^]*?\n\}|fail: "Handler ném exception[^]*?\n\}/)?.[0];
    assert.ok(failure, path);
    assert.doesNotMatch(failure, /postHandle/);
    assert.match(source, /afterCompletion/);
    assert.match(source, /preHandle.*false/);
  }
});

test('JPA and JDBC transaction diagrams preserve rollback, flush and connection cleanup', () => {
  const jpa = documents.find((document) => document.path === 'jpa-hibernate/transactions-with-jpa.md').value;
  for (const label of ['flush persistence context', 'INSERT order', 'UPDATE product WHERE version = oldVersion', 'ROLLBACK', 'COMMIT']) assert.ok(jpa.includes(label), label);
  const jdbc = documents.find((document) => document.path === 'spring/spring-transaction.md').value;
  for (const label of ['getTransactionAttribute(method, class)', 'bindResource(DataSource, Connection)', 'unbindResource(DataSource)', 'connection.close() — trả về pool', 'return / rethrow']) assert.ok(jdbc.includes(label), label);
});
