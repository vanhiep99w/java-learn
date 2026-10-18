import { resolve } from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { unified } from 'unified';
import { remarkD2 } from '@vanhiep99w/docs-kit/d2';
import { visit } from 'unist-util-visit';
import { projectRoot, readDocuments } from './build-source-examples.mjs';
import { d2Options, D2_LAYOUTS, pageLayout, diagramLayout } from './d2-options.mjs';
import { checkInventory } from './diagram-inventory.mjs';

const inventory = await checkInventory();

const diagrams = [], remaining = [];
for (const document of await readDocuments(resolve(projectRoot, 'content/docs'))) {
  const sources = [];
  const page = pageLayout(document.tree);
  visit(document.tree, 'code', (node) => {
    if (node.lang === 'd2') sources.push({ line: node.position.start.line, source: node.value, layout: diagramLayout(node, page) });
    else if (node.lang === 'mermaid') {
      remaining.push({ path: document.path, line: node.position.start.line, language: node.lang ?? 'text', preview: node.value.split('\n').slice(0, 2).join(' / ') });
    }
  });
  if (!sources.length) continue;
  await unified().use(remarkD2, d2Options)
    .run(document.tree, { path: resolve(projectRoot, 'content/docs', document.path), value: document.value });
  let index = 0;
  visit(document.tree, (node) => {
    if (node.type !== 'mdxJsxFlowElement' || !['D2Diagram', 'D2InteractiveDiagram'].includes(node.name)) return;
    // docs-kit emits strings as JSON literals, structured props as JSON.parse literals.
    // Decode that bounded grammar without evaluating authored JavaScript.
    const props = Object.fromEntries(node.attributes.map((attr) => {
      const expression = attr.value.value;
      const value = expression.startsWith('JSON.parse(')
        ? JSON.parse(JSON.parse(expression.slice(11, -1))) : JSON.parse(expression);
      return [attr.name, value];
    }));
    const source = sources[index++];
    const sequence = /^shape: sequence_diagram/m.test(source.source);
    for (const [boardIndex, board] of (props.boards ?? [props]).entries()) {
      const dimensions = (svg) => {
        const root = svg.slice(0, svg.indexOf('>'));
        return { width: Number(root.match(/\bwidth="([\d.]+)"/)[1]), height: Number(root.match(/\bheight="([\d.]+)"/)[1]) };
      };
      const { width, height } = dimensions(board.lightSvg);
      const dark = dimensions(board.darkSvg);
      diagrams.push({ path: document.path, line: source.line,
        caption: boardIndex === 0 ? props.caption : board.label,
        layout: source.layout, width, height, darkWidth: dark.width, darkHeight: dark.height, sequence,
        interactive: node.name === 'D2InteractiveDiagram', board: board.id,
        tallNarrow: !sequence && height > 650 && height > width * 1.5,
        oversized: height > 1400 || width > 1800,
      });
    }
  });
}
const budgets = JSON.parse(await readFile(resolve(projectRoot, 'scripts/diagram-layout-budgets.json'), 'utf8'));
const budgetChecks = budgets.flatMap((budget) => budget.captions.map((caption) => {
  const matches = diagrams.filter((entry) => entry.path === budget.path && entry.caption === caption);
  const actual = matches[0];
  return { path: budget.path, caption, maxWidth: budget.maxWidth, maxHeight: budget.maxHeight,
    width: actual?.width, height: actual?.height,
    passed: matches.length === 1 && actual.width <= budget.maxWidth && actual.height <= budget.maxHeight,
  };
}));
for (const check of budgetChecks.filter((entry) => !entry.passed)) {
  console.error(`LAYOUT BUDGET FAILED: ${check.path} — ${check.caption}: ${check.width ?? 'missing'}×${check.height ?? 'missing'}, max ${check.maxWidth}×${check.maxHeight}`);
  process.exitCode = 1;
}
const output = resolve(projectRoot, '.cache/docs-kit/diagram-audit.json');
await mkdir(resolve(output, '..'), { recursive: true });
await writeFile(output, JSON.stringify({ diagrams, remaining, inventory, budgetChecks }, null, 2) + '\n');
console.log(`${diagrams.length} D2 views measured; ${remaining.length} unconverted diagrams; ${inventory.reviewedText} reviewed non-diagram fences.`);
for (const entry of diagrams.filter((item) => item.tallNarrow || item.oversized)) {
  console.log(`${entry.width}×${entry.height} ${entry.tallNarrow ? 'TALL/NARROW' : 'REVIEW'} ${entry.path}:${entry.line} — ${entry.caption}`);
}
console.log('Layouts:', Object.fromEntries(D2_LAYOUTS.map((layout) => [layout, diagrams.filter((item) => item.layout === layout).length])));
console.log(`${budgetChecks.filter((check) => check.passed).length}/${budgetChecks.length} layout budgets passed.`);
console.log(`Full report: ${output}`);
