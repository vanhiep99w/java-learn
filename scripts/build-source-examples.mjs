import { readdir, readFile, mkdir, writeFile, rm, rename } from 'node:fs/promises';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createProcessor } from '@mdx-js/mdx';
import remarkFrontmatter from 'remark-frontmatter';
import { visit } from 'unist-util-visit';
import { createHighlighter } from 'shiki';
import { remarkSourceReferences } from './source-references.mjs';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const processors = {
  md: createProcessor({ format: 'md', remarkPlugins: [remarkFrontmatter] }),
  mdx: createProcessor({ format: 'mdx', remarkPlugins: [remarkFrontmatter] }),
};
const languages = ['java', 'sql', 'yaml', 'xml', 'properties', 'bash', 'json', 'text'];

export async function readDocuments(docsDir) {
  const paths = (await readdir(docsDir, { recursive: true }))
    .filter((path) => /\.mdx?$/.test(path)).sort();
  return Promise.all(paths.map(async (path) => {
    const value = await readFile(resolve(docsDir, path), 'utf8');
    try {
      return { path, value, tree: processors[path.endsWith('.mdx') ? 'mdx' : 'md'].parse(value) };
    } catch (error) {
      throw new Error(`${path}: ${error.message}`, { cause: error });
    }
  }));
}

function fail(document, node, message) {
  throw new Error(`${document.path}:${node.position?.start.line ?? 1}: ${message}`);
}

function safePath(path) {
  return path && !path.startsWith('/') && !path.includes('\\') &&
    path.split('/').every((part) => part && part !== '.' && part !== '..');
}

/** Source lives in the doc fence; no second copy of teaching examples to drift. */
export function collectExamples(documents) {
  const projects = new Map();
  const references = [];
  for (const document of documents) {
    remarkSourceReferences()(document.tree, { fail(message, node) { fail(document, node, message); } });
    visit(document.tree, (node) => {
      if (node.type === 'code' && /\bsource=/.test(node.meta ?? '')) {
        const match = node.meta.match(/(?:^|\s)source="([^"]+)"(?:\s|$)/);
        if (!match || !safePath(match[1])) fail(document, node, 'Invalid source="project/file" metadata');
        const [project, ...parts] = match[1].split('/');
        const path = parts.join('/');
        if (!/^[a-z0-9][a-z0-9-]*$/.test(project) || !path) fail(document, node, 'Invalid source project or file');
        if (!languages.includes(node.lang)) fail(document, node, `Unsupported source language: ${node.lang}`);
        if (!node.value.trim()) fail(document, node, 'Source example cannot be empty');
        const titleMatch = document.value.match(/^title:\s*(.*?)\s*$/m);
        const title = titleMatch?.[1].replace(/^(["'])(.*)\1$/, '$2') ?? project;
        if (!projects.has(project)) projects.set(project, { title, document: document.path, files: new Map() });
        const entry = projects.get(project);
        if (entry.document !== document.path) fail(document, node, `Project ${project} belongs to another document`);
        if (entry.files.has(path)) fail(document, node, `Duplicate source file: ${project}/${path}`);
        const code = node.value;
        entry.files.set(path, {
          path, language: node.lang, code,
          regions: { example: [1, code.split('\n').length] },
        });
      }
      if ((node.type === 'mdxJsxFlowElement' || node.type === 'mdxJsxTextElement') && node.name === 'SourceRef') {
        const props = {};
        for (const attr of node.attributes) {
          if (attr.type !== 'mdxJsxAttribute' || typeof attr.value !== 'string') {
            fail(document, node, 'SourceRef requires literal string attributes for build-time validation');
          }
          props[attr.name] = attr.value;
        }
        references.push({ document, node, props });
      }
    });
  }
  for (const { document, node, props } of references) {
    const allowed = new Set(['project', 'snapshot', 'file', 'region', 'lines', 'variant']);
    for (const key of Object.keys(props)) {
      if (!allowed.has(key)) fail(document, node, `Unknown SourceRef attribute: ${key}`);
    }
    const project = projects.get(props.project);
    if (!project) fail(document, node, `Unknown SourceRef project: ${props.project}`);
    if (props.snapshot && props.snapshot !== 'main') fail(document, node, `Unknown snapshot: ${props.snapshot}`);
    const file = props.file ? project.files.get(props.file) : project.files.values().next().value;
    if (!file) fail(document, node, `Unknown source file: ${props.file}`);
    if (props.region && props.lines) fail(document, node, 'Use region OR lines, not both');
    if (props.region && !file.regions[props.region]) fail(document, node, `Unknown region: ${props.region}`);
    if (props.lines) {
      const match = props.lines.match(/^(\d+)(?:-(\d+))?$/);
      const start = Number(match?.[1]), end = Number(match?.[2] ?? match?.[1]);
      if (!match || start < 1 || end < start || end > file.code.split('\n').length) {
        fail(document, node, `Invalid line range: ${props.lines}`);
      }
    }
    if (props.variant && !['inline', 'button'].includes(props.variant)) fail(document, node, 'Invalid SourceRef variant');
  }
  return { projects, references };
}

export async function buildSourceExamples({
  docsDir = resolve(projectRoot, 'content/docs'),
  outputDir = resolve(projectRoot, 'public/source-examples'),
} = {}) {
  const { projects, references } = collectExamples(await readDocuments(docsDir));
  const highlighter = await createHighlighter({ themes: ['github-light', 'github-dark'], langs: languages });
  const staging = `${outputDir}.tmp-${process.pid}`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true });
  const manifest = [];
  let count = 0;
  try {
    for (const [id, project] of projects) {
      const files = [...project.files.values()].sort((a, b) => a.path.localeCompare(b.path));
      for (const file of files) {
        file.html = highlighter.codeToHtml(file.code, {
          lang: file.language,
          themes: { light: 'github-light', dark: 'github-dark' },
          transformers: [{ line(node, line) { node.properties['data-line'] = line; } }],
        });
      }
      const asset = `${id}-main.json`;
      await writeFile(resolve(staging, asset), JSON.stringify({
        project: id, snapshot: 'main', defaultFile: files[0].path, files,
      }));
      manifest.push({ id, title: project.title, defaultSnapshot: 'main', snapshots: [
        { id: 'main', title: 'Ví dụ trong bài (độc lập)', asset },
      ] });
      count += files.length;
    }
    await writeFile(resolve(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    await mkdir(dirname(outputDir), { recursive: true });
    await rm(outputDir, { recursive: true, force: true });
    await rename(staging, outputDir);
  } finally {
    highlighter.dispose();
    await rm(staging, { recursive: true, force: true });
  }
  console.log(`[source-examples] ${projects.size} projects, ${count} files, ${references.length} validated references → ${relative(projectRoot, outputDir)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildSourceExamples();
}
