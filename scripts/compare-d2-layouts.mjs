import { resolve, relative } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { unified } from 'unified';
import { remarkD2 } from '@vanhiep99w/docs-kit/d2';
import { visit } from 'unist-util-visit';
import { projectRoot, readDocuments } from './build-source-examples.mjs';
import { D2_LAYOUTS, d2Options, diagramMeta, diagramLayout, pageLayout } from './d2-options.mjs';

const args = process.argv.slice(2);
function option(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`${name} needs a value`);
  return args[i + 1];
}
const limit = Number(option('--limit', '12'));
if (!Number.isInteger(limit) || limit < 1) throw new Error('--limit must be positive');
const filter = new RegExp(option('--filter', '.*'), 'i');
const layouts = option('--layouts', D2_LAYOUTS.join(',')).split(',');
if (layouts.some((name) => !D2_LAYOUTS.includes(name))) throw new Error('Unknown layout');
const selectionPath = option('--selection');
const selection = selectionPath ? JSON.parse(await readFile(resolve(selectionPath), 'utf8')) : null;
const output = resolve(projectRoot, option('--output-dir', '.cache/docs-kit/layout-comparison'));
const candidates = [];
for (const document of await readDocuments(resolve(projectRoot, 'content/docs'))) {
  const page = pageLayout(document.tree);
  visit(document.tree, 'code', (node) => {
    if (node.lang !== 'd2') return;
    const title = diagramMeta(node.meta).title ?? d2Options.defaultCaption;
    if (!filter.test(`${document.path} ${title}`)) return;
    if (selection && !selection.some((item) => item.path === document.path &&
      (!item.title || item.title === title) && (!item.signature || node.value.includes(item.signature)))) return;
    candidates.push({ document, node, title, current: diagramLayout(node, page) });
  });
}
await mkdir(output, { recursive: true });
const results = [];
for (const [i, candidate] of candidates.slice(0, limit).entries()) {
  const { document, node, title, current } = candidate;
  const id = `${String(i + 1).padStart(2, '0')}-${document.path.split('/').at(-1).replace(/\.mdx?$/, '')}`;
  const entry = { path: document.path, line: node.position.start.line, caption: title, current, alternatives: [] };
  await mkdir(resolve(output, id), { recursive: true });
  for (const engine of layouts) {
    const started = performance.now();
    try {
      // An explicit fence override beats any page setting; never compare the same
      // resolved engine three times by accident. Isolated SVG files avoid ID collisions.
      const isolated = { type: 'root', children: [{ ...node, meta: `layout="${engine}" title="${title.replaceAll('"', '')}"` }] };
      await unified().use(remarkD2, d2Options).run(isolated, {
        path: resolve(projectRoot, 'content/docs', `${document.path}.comparison-${i}`), value: document.value,
      });
      const props = Object.fromEntries(isolated.children[0].attributes.map((attr) => [attr.name, JSON.parse(attr.value.value)]));
      const root = props.lightSvg.slice(0, props.lightSvg.indexOf('>'));
      const width = Number(root.match(/\bwidth="([\d.]+)"/)[1]);
      const height = Number(root.match(/\bheight="([\d.]+)"/)[1]);
      const light = `${id}/${engine}-light.svg`, dark = `${id}/${engine}-dark.svg`;
      await writeFile(resolve(output, light), props.lightSvg);
      await writeFile(resolve(output, dark), props.darkSvg);
      entry.alternatives.push({ layout: engine, width, height, elapsedMs: Math.round(performance.now() - started), light, dark });
      console.log(`${document.path}:${node.position.start.line} ${engine}: ${width}×${height}`);
    } catch (error) {
      entry.alternatives.push({ layout: engine, error: error.message });
      console.error(`${document.path}:${node.position.start.line} ${engine}: ${error.message}`);
    }
  }
  results.push(entry);
}
await writeFile(resolve(output, 'report.json'), JSON.stringify(results, null, 2) + '\n');
const escape = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const html = `<!doctype html><html lang="vi"><meta charset="utf-8"><title>D2 layout comparison</title>
<style>body{font:14px system-ui;margin:24px;background:#f5f5f5;color:#222}section{margin:32px 0}.layouts{display:grid;grid-template-columns:repeat(${layouts.length},minmax(0,1fr));gap:16px}article{background:white;padding:12px;border:1px solid #ccc}.preview{overflow:auto;max-height:800px}img{display:block;max-width:none}.dark-preview{background:#111}pre{white-space:pre-wrap}summary{cursor:pointer;margin:12px 0}</style>
<h1>D2 layout comparison</h1><p>SVG ở kích thước render thật, không thu nhỏ font. Chọn bằng khả năng đọc/đường nối; không chỉ theo diện tích. elapsedMs có thể gồm cache hit, không phải benchmark.</p>
${results.map((entry) => `<section><h2>${escape(entry.caption)}</h2><p>${escape(entry.path)}:${entry.line}; hiện tại: ${entry.current}</p><div class="layouts">${entry.alternatives.map((variant) => `<article><h3>${variant.layout}${variant.error ? '' : ` — ${variant.width}×${variant.height}`}</h3>${variant.error ? `<pre>${escape(variant.error)}</pre>` : `<div class="preview"><a href="${variant.light}"><img src="${variant.light}" alt="${escape(entry.caption)}"></a></div><details><summary>Dark</summary><div class="preview dark-preview"><img src="${variant.dark}" alt="${escape(entry.caption)} (dark)"></div></details>`}</article>`).join('')}</div></section>`).join('')}</html>`;
await writeFile(resolve(output, 'index.html'), html);
console.log(`Compared ${results.length} diagrams. Review ${relative(projectRoot, output)}/index.html and report.json. No docs were modified.`);
