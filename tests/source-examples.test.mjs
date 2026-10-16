import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compile } from '@mdx-js/mdx';
import { buildSourceExamples, readDocuments, collectExamples } from '../scripts/build-source-examples.mjs';
import { parseSourceRef, remarkSourceReferences } from '../scripts/source-references.mjs';

const fence = '```java source="demo/01/Demo.java"\nclass Demo {\n    String value = "<script>alert(1)</script>";\n}\n```';
const ref = '<SourceRef project="demo" file="01/Demo.java" region="example" variant="button">Xem Demo.java</SourceRef>';

async function fixture(t, source, extension = 'md') {
  const root = await mkdtemp(join(tmpdir(), 'java-source-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const docsDir = join(root, 'docs'), outputDir = join(root, 'public/source-examples');
  await mkdir(docsDir);
  await writeFile(join(docsDir, `demo.${extension}`), source);
  return { root, docsDir, outputDir };
}

test('Markdown SourceRef becomes a React component, not a raw HTML tag', async () => {
  const output = String(await compile(ref, { format: 'md', remarkPlugins: [remarkSourceReferences] }));
  assert.match(output, /SourceRef/);
  assert.match(output, /project: "demo"/);
  assert.doesNotMatch(output, /&lt;SourceRef/);
  assert.deepEqual(parseSourceRef(ref).props, {
    project: 'demo', file: '01/Demo.java', region: 'example', variant: 'button',
  });
});

test('literal JSX works in MDX too', async (t) => {
  const fixturePaths = await fixture(t, `${fence}\n\n${ref}\n`, 'mdx');
  const result = collectExamples(await readDocuments(fixturePaths.docsDir));
  assert.equal(result.references.length, 1);
});

test('builds deterministic static assets, escaped dual-theme HTML and numbered lines', async (t) => {
  const paths = await fixture(t, `---\ntitle: "Demo source"\n---\n\n${fence}\n\n${ref}\n`);
  await buildSourceExamples(paths);
  const manifestText = await readFile(join(paths.outputDir, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestText);
  assert.equal(manifest[0].title, 'Demo source');
  const asset = join(paths.outputDir, manifest[0].snapshots[0].asset);
  const snapshotText = await readFile(asset, 'utf8');
  const snapshot = JSON.parse(snapshotText);
  assert.equal(snapshot.defaultFile, '01/Demo.java');
  const file = snapshot.files[0];
  assert.deepEqual(file.regions.example, [1, 3]);
  assert.match(file.html, /class="line" data-line="1"/);
  assert.match(file.html, /--shiki-dark/);
  assert.match(file.html, /&#x3C;script>/);
  assert.doesNotMatch(file.html, /<script>/);
  assert.equal(file.code, 'class Demo {\n    String value = "<script>alert(1)</script>";\n}');
  await writeFile(join(paths.outputDir, 'stale.json'), '{}');
  await buildSourceExamples(paths);
  assert.equal(await readFile(asset, 'utf8'), snapshotText);
  assert.equal(await readFile(join(paths.outputDir, 'manifest.json'), 'utf8'), manifestText);
  await assert.rejects(readFile(join(paths.outputDir, 'stale.json')), { code: 'ENOENT' });
});

for (const [name, source, message] of [
  ['unknown attribute', `${fence}\n\n${ref.replace('region="example"', 'regions="example"')}`, /Unknown SourceRef attribute/],
  ['duplicate attribute', `${fence}\n\n${ref.replace('region="example"', 'region="example" region="other"')}`, /Duplicate SourceRef attribute/],
  ['unknown project', `${fence}\n\n${ref.replace('project="demo"', 'project="missing"')}`, /Unknown SourceRef project/],
  ['unknown file', `${fence}\n\n${ref.replace('01/Demo.java" region', 'missing.java" region')}`, /Unknown source file/],
  ['unknown region', `${fence}\n\n${ref.replace('region="example"', 'region="missing"')}`, /Unknown region/],
  ['invalid range', `${fence}\n\n${ref.replace('region="example"', 'lines="1-4"')}`, /Invalid line range/],
  ['zero line', `${fence}\n\n${ref.replace('region="example"', 'lines="0"')}`, /Invalid line range/],
  ['reversed range', `${fence}\n\n${ref.replace('region="example"', 'lines="3-1"')}`, /Invalid line range/],
  ['conflicting range', `${fence}\n\n${ref.replace('region="example"', 'region="example" lines="1-2"')}`, /region OR lines/],
  ['unknown snapshot', `${fence}\n\n${ref.replace('region="example"', 'snapshot="old"')}`, /Unknown snapshot/],
  ['duplicate file', `${fence}\n\n${fence}`, /Duplicate source file/],
  ['traversal', fence.replace('demo/01/Demo.java', 'demo/../secret.java'), /Invalid source/],
  ['absolute path', fence.replace('demo/01/Demo.java', '/demo/Demo.java'), /Invalid source/],
  ['invalid JSX attributes', `${fence}\n\n${ref.replace('project="demo"', 'project={project}')}`, /Invalid SourceRef attributes/],
]) {
  test(`rejects ${name} with document position`, async (t) => {
    const paths = await fixture(t, source);
    const docs = await readDocuments(paths.docsDir);
    assert.throws(() => collectExamples(docs), (error) => {
      assert.match(error.message, /demo\.md:\d+:/);
      assert.match(error.message, message);
      return true;
    });
  });
}

test('valid line references and defaults work', async (t) => {
  const paths = await fixture(t, `${fence}\n\n<SourceRef project="demo" lines="1-2">Lines</SourceRef>`);
  assert.equal(collectExamples(await readDocuments(paths.docsDir)).references.length, 1);
});

test('code fences containing SourceRef examples are not mistaken for real references', async (t) => {
  const paths = await fixture(t, '```mdx\n<SourceRef project="missing">Example</SourceRef>\n```');
  assert.equal(collectExamples(await readDocuments(paths.docsDir)).references.length, 0);
});
