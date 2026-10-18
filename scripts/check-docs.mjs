import { resolve } from 'node:path';
import { unified } from 'unified';
import { remarkD2 } from '@vanhiep99w/docs-kit/d2';
import { visit } from 'unist-util-visit';
import { collectExamples, projectRoot, readDocuments } from './build-source-examples.mjs';
import { learningPlugins } from './learning-plugins.mjs';
import { d2Options } from './d2-options.mjs';
import { checkInventory } from './diagram-inventory.mjs';

const documents = await readDocuments(resolve(projectRoot, 'content/docs'));
const { projects, references } = collectExamples(documents);
const inventory = await checkInventory(documents);
let d2 = 0, mermaid = 0;
for (const document of documents) {
  for (const match of document.value.matchAll(/^```d2([^\n]*)/gm)) {
    if (match[1].includes('`')) throw new Error(`${document.path}: backticks are not allowed in D2 fence captions`);
  }
  await unified().use(learningPlugins).run(structuredClone(document.tree), { path: resolve(projectRoot, 'content/docs', document.path), value: document.value });
  let hasD2 = false;
  visit(document.tree, 'code', (node) => {
    if (node.lang === 'd2') { d2++; hasD2 = true; }
    if (node.lang === 'mermaid') mermaid++;
  });
  if (hasD2) await unified().use(remarkD2, d2Options).run(document.tree, { path: resolve(projectRoot, 'content/docs', document.path), value: document.value });
}
console.log(`[docs] ${documents.length} pages; ${d2} D2 diagrams validated; ${mermaid} Mermaid diagrams; ${inventory.reviewedText} reviewed non-diagram fences; ${projects.size} source projects, ${references.length} references validated`);
