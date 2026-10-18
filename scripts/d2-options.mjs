import { parseDocument } from 'yaml';

export const D2_LAYOUTS = Object.freeze(['elk', 'dagre', 'tala']);
export const d2Options = Object.freeze({
  layout: 'elk',
  assetsRoot: 'content/assets/d2',
  cacheDir: '.next/cache/docs-kit/d2',
  defaultCaption: 'Sơ đồ',
});

function layout(value) {
  if (!D2_LAYOUTS.includes(value)) throw new Error(`Invalid D2 layout: ${value}`);
  return value;
}

/** Same literal attribute grammar as docs-kit; quoted titles cannot set layout. */
export function diagramMeta(meta = '') {
  const result = {};
  const attributes = /(?:^|\s)([^\s=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s]*))?(?=\s|$)/g;
  for (const [, name, raw] of meta.matchAll(attributes)) {
    const value = raw && /^("[^"]*"|'[^']*')$/.test(raw) ? raw.slice(1, -1) : raw;
    if (name === 'title' && result.title === undefined) result.title = value;
    if (name === 'layout') {
      if (result.layout !== undefined) throw new Error('Duplicate D2 fence layout');
      result.layout = layout(value);
    }
  }
  return result;
}

export function pageLayout(tree) {
  const node = tree.children.find((child) => child.type === 'yaml');
  if (!node) return undefined;
  const document = parseDocument(node.value);
  if (document.errors.length) throw document.errors[0];
  const frontmatter = document.toJS();
  return frontmatter && Object.hasOwn(frontmatter, 'd2Layout') ? layout(frontmatter.d2Layout) : undefined;
}

export function diagramLayout(node, page) {
  return diagramMeta(node.meta).layout ?? page ?? d2Options.layout;
}
