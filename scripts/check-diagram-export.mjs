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
    const expected = diagrams[i];
    for (const theme of ['light', 'dark']) {
      const svg = figure[1].match(new RegExp(`class="d2-diagram-${theme}"[^>]*>(<svg\\b[^>]*>)`))?.[1] ?? '';
      const width = Number(svg.match(/\bwidth="([\d.]+)"/)?.[1]);
      const height = Number(svg.match(/\bheight="([\d.]+)"/)?.[1]);
      const expectedWidth = theme === 'dark' ? expected.darkWidth : expected.width;
      const expectedHeight = theme === 'dark' ? expected.darkHeight : expected.height;
      if (width !== expectedWidth || height !== expectedHeight) {
        errors.push(`${path}: ${expected.caption} (${expected.layout}, ${theme}) audit=${expectedWidth}×${expectedHeight}, export=${width}×${height}`);
      }
    }
    if (/<image\b[^>]*(?:href|src)="https?:\/\//.test(figure[1])) errors.push(`${path}: icon not embedded`);
    checked++;
  }
}
if (errors.length) throw new Error(`Diagram export differs from audit; rerun docs:audit and build.\n${errors.join('\n')}`);
console.log(`[diagram-export] ${checked} diagrams across ${pages.size} pages match the audited layout sizes (including page/fence overrides).`);
