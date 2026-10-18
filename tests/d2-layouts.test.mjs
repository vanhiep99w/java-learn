import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { unified } from 'unified';
import { remarkD2 } from '@vanhiep99w/docs-kit/d2';
import { visit } from 'unist-util-visit';
import { d2Options, diagramMeta, diagramLayout, pageLayout } from '../scripts/d2-options.mjs';
import { readDocuments, projectRoot } from '../scripts/build-source-examples.mjs';
import { docsPageSchema } from '../src/lib/docs-schema.mjs';

test('frontmatter schema retains the optional layout field and rejects invalid engines', () => {
  assert.equal(docsPageSchema.parse({ title: 'Page', d2Layout: 'tala' }).d2Layout, 'tala');
  assert.equal(docsPageSchema.parse({ title: 'Page' }).d2Layout, undefined);
  assert.throws(() => docsPageSchema.parse({ title: 'Page', d2Layout: 'auto' }));
});

test('report metadata parser handles quotes, precedence and invalid directives', () => {
  assert.deepEqual(diagramMeta('title="Use layout=tala literally" layout=dagre'), {
    title: 'Use layout=tala literally', layout: 'dagre',
  });
  assert.equal(diagramMeta("layout='tala'").layout, 'tala');
  assert.equal(diagramLayout({ meta: '' }, 'tala'), 'tala');
  assert.equal(diagramLayout({ meta: 'layout=elk' }, 'tala'), 'elk');
  assert.equal(diagramLayout({ meta: '' }, undefined), 'elk');
  assert.throws(() => diagramMeta('layout=tala layout=elk'), /Duplicate/);
  assert.throws(() => diagramMeta('layout=TALA'), /Invalid/);
});

test('reviewed engine choices remain scoped to their page/block', async () => {
  const review = JSON.parse(await readFile(resolve(projectRoot, 'scripts/d2-layout-review.json'), 'utf8'));
  const documents = await readDocuments(resolve(projectRoot, 'content/docs'));
  for (const decision of review) {
    const document = documents.find((entry) => entry.path === decision.path);
    const page = pageLayout(document.tree);
    const matches = [];
    visit(document.tree, 'code', (node) => {
      if (node.lang === 'd2' && diagramMeta(node.meta).title === decision.title &&
        (!decision.signature || node.value.includes(decision.signature))) matches.push(node);
    });
    assert.equal(matches.length, 1, `${decision.path}: ${decision.title}`);
    assert.equal(diagramLayout(matches[0], page), decision.expectedLayout, `${decision.path}: ${decision.reason}`);
  }
  const pool = documents.find((entry) => entry.path === 'spring/connection-pool.md');
  assert.equal(pageLayout(pool.tree), 'tala');
  const blocks = [];
  visit(pool.tree, 'code', (node) => { if (node.lang === 'd2') blocks.push(node); });
  assert.equal(diagramLayout(blocks[0], 'tala'), 'elk', 'architecture fence overrides page TALA');
  assert.equal(diagramLayout(blocks[1], 'tala'), 'tala', 'connection lifecycle inherits page TALA');
  const jvm = documents.find((entry) => entry.path === 'jvm/jvm-architecture.md');
  const overview = [];
  visit(jvm.tree, 'code', (node) => {
    if (node.lang === 'd2' && diagramMeta(node.meta).title?.startsWith('JVM:')) overview.push(node);
  });
  assert.deepEqual(overview.map((node) => diagramLayout(node, pageLayout(jvm.tree))), ['elk', 'elk']);
});

const fixture = 'direction: right\na: A\nb: B\nc: C\na -> b\nb -> c\nc -> a';
async function render({ engine = 'elk', meta = '', yaml, frontmatter } = {}) {
  const tree = { type: 'root', children: [
    ...(yaml ? [{ type: 'yaml', value: yaml }] : []),
    { type: 'code', lang: 'd2', meta, value: fixture },
  ] };
  await unified().use(remarkD2, { ...d2Options, layout: engine }).run(tree, {
    path: resolve(projectRoot, '.cache/docs-kit/layout-priority-fixture.md'),
    data: frontmatter ? { frontmatter } : {},
  });
  const component = tree.children.find((node) => ['D2Diagram', 'D2InteractiveDiagram'].includes(node.name));
  return JSON.parse(component.attributes.find((attr) => attr.name === 'lightSvg').value.value);
}

test('real renderer honors fence > YAML/host frontmatter > global default, without fallback', async () => {
  const elk = await render();
  const tala = await render({ meta: 'layout=tala' });
  assert.notEqual(elk, tala, 'fixture must distinguish the two engines');
  assert.equal(await render({ yaml: 'd2Layout: tala' }), tala);
  assert.equal(await render({ frontmatter: { d2Layout: 'tala' } }), tala, 'Fumadocs-stripped frontmatter works');
  assert.equal(await render({ engine: 'tala', frontmatter: { d2Layout: 'tala' }, meta: 'layout=elk' }), elk);
  assert.equal(await render({ meta: 'title="A title mentioning layout=tala"' }), elk);
  await assert.rejects(render({ meta: 'layout=unknown' }), /must be elk, dagre or tala/);
  await assert.rejects(render({ meta: 'layout=tala layout=elk' }), /duplicate fence layout/);
  await assert.rejects(render({ yaml: 'd2Layout: invalid' }), /must be elk, dagre or tala/);
});
