import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { projectRoot } from './build-source-examples.mjs';

const output = resolve(projectRoot, process.argv[2] ?? 'dist');
const report = JSON.parse(await readFile(resolve(projectRoot, '.cache/docs-kit/diagram-audit.json'), 'utf8'));
const pages = new Map();
for (const diagram of report.diagrams) {
  if (!pages.has(diagram.path)) pages.set(diagram.path, []);
  pages.get(diagram.path).push(diagram);
}
let checked = 0;
const errors = [];
for (const [path, diagrams] of pages) {
  const route = path.replace(/\.mdx?$/, '').replace(/(^|\/)index$/, '');
  const html = await readFile(resolve(output, route, 'index.html'), 'utf8');
  const figures = [...html.matchAll(/<figure\b[^>]*\bclass="d2-diagram\b[^"]*"[^>]*>([\s\S]*?)<\/figure>/g)];
  if (figures.length !== diagrams.length) {
    errors.push(`${path}: expected ${diagrams.length} D2 figures, exported ${figures.length}`);
    continue;
  }
  for (const [i, figure] of figures.entries()) {
    const svg = figure[1].match(/<svg\b[^>]*>/)?.[0] ?? '';
    const width = Number(svg.match(/\bwidth="([\d.]+)"/)?.[1]);
    const height = Number(svg.match(/\bheight="([\d.]+)"/)?.[1]);
    const expected = diagrams[i];
    if (width !== expected.width || height !== expected.height) {
      errors.push(`${path}: ${expected.caption} (${expected.layout}) audit=${expected.width}×${expected.height}, export=${width}×${height}`);
    }
    checked++;
  }
}
if (errors.length) throw new Error(`Diagram export differs from audit; rerun docs:audit and build.\n${errors.join('\n')}`);
console.log(`[diagram-export] ${checked} diagrams across ${pages.size} pages match the audited layout sizes (including page/fence overrides).`);
