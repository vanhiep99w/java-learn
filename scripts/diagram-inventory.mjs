import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { visit } from 'unist-util-visit';
import { projectRoot, readDocuments } from './build-source-examples.mjs';

export const digest = (value) => createHash('sha256').update(value).digest('hex');
// Review every unlabelled/text fence, plus visual notation inside other languages.
// A character hit is a candidate, never automatic permission to rewrite real code/logs.
export function inventoryCandidates(documents) {
  const result = [];
  for (const document of documents) visit(document.tree, 'code', (node) => {
    if (node.lang === 'd2') return;
    if (!node.lang || ['text', 'plaintext', 'ascii', 'mermaid'].includes(node.lang) || /[\u2500-\u257f\u2580-\u259f]|-->|^\s*\/\/[^\n]*(?:→.*→|[-─]{2,}[>►]|[↑↓▼▲])/mu.test(node.value)) {
      result.push({ path: document.path, line: node.position.start.line,
        language: node.lang ?? 'plain', sha256: digest(node.value), preview: node.value.split('\n')[0] });
    }
  });
  return result;
}
export async function checkInventory(documents = undefined) {
  documents ??= await readDocuments(resolve(projectRoot, 'content/docs'));
  const review = JSON.parse(await readFile(resolve(projectRoot, 'scripts/diagram-inventory.json'), 'utf8'));
  const candidates = inventoryCandidates(documents);
  const key = (entry) => `${entry.path}:${entry.language}:${entry.sha256}`;
  const approved = new Map(review.retained.map((entry) => [key(entry), entry]));
  const errors = [];
  for (const candidate of candidates) {
    if (candidate.language === 'mermaid') errors.push(`Mermaid: ${candidate.path}:${candidate.line}`);
    if (!approved.has(key(candidate))) errors.push(`Unreviewed text/visual: ${candidate.path}:${candidate.line} ${candidate.preview}`);
  }
  const current = new Set(candidates.map(key));
  for (const entry of review.retained) if (!current.has(key(entry))) errors.push(`Stale inventory: ${entry.path} ${entry.preview}`);
  for (const document of documents) {
    if (/<Mermaid\b/.test(document.value)) errors.push(`Legacy Mermaid JSX: ${document.path}`);
    // Catch diagrams outside fences too; normal arrows in Vietnamese prose are fine.
    const prose = document.value.split('\n');
    visit(document.tree, 'code', (node) => {
      for (let line = node.position.start.line; line <= node.position.end.line; line++) prose[line - 1] = '';
    });
    if (/[\u2500-\u257f\u2580-\u259f]/u.test(prose.join('\n'))) errors.push(`Box/bar notation outside code: ${document.path}`);
  }
  if (errors.length) throw new Error(errors.join('\n'));
  return { pages: documents.length, reviewedText: candidates.length, converted: review.converted.length };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log('[diagram-inventory]', await checkInventory());
}
