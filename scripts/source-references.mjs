import { visit } from 'unist-util-visit';

/** Strict JSX-like syntax for .md pages, which otherwise treat JSX as raw HTML. */
export function parseSourceRef(value) {
  const match = value.trim().match(/^<SourceRef\b([^>]*)>([^<>]*)<\/SourceRef>$/s);
  if (!match) throw new Error('SourceRef must contain plain text and literal string attributes');
  const props = {};
  let rest = match[1].trim();
  while (rest) {
    const attr = rest.match(/^([a-z]+)="([^"]*)"(?:\s+|$)/);
    if (!attr) throw new Error(`Invalid SourceRef attributes: ${rest}`);
    if (Object.hasOwn(props, attr[1])) throw new Error(`Duplicate SourceRef attribute: ${attr[1]}`);
    props[attr[1]] = attr[2];
    rest = rest.slice(attr[0].length);
  }
  return { props, label: match[2].trim() };
}

function element(reference, type, position) {
  return {
    type, name: 'SourceRef', position,
    attributes: Object.entries(reference.props).map(([name, value]) => ({
      type: 'mdxJsxAttribute', name, value,
    })),
    children: [{ type: 'text', value: reference.label }],
  };
}

export function remarkSourceReferences() {
  return (tree, file) => {
    function parse(value, node) {
      try { return parseSourceRef(value); }
      catch (error) { file.fail(error.message, node); }
    }
    visit(tree, (node, index, parent) => {
      // Markdown tokenizes a one-line tag as opening HTML + text + closing HTML.
      if (node.type === 'paragraph') {
        for (let i = 0; i < node.children.length; i++) {
          const open = node.children[i];
          if (open.type !== 'html' || !/^<SourceRef\b/.test(open.value)) continue;
          const closeIndex = node.children.findIndex((child, j) => j > i && child.type === 'html' && child.value === '</SourceRef>');
          if (closeIndex < 0) file.fail('SourceRef is missing a closing tag', open);
          const middle = node.children.slice(i + 1, closeIndex);
          if (middle.some((child) => child.type !== 'text')) file.fail('SourceRef label must be plain text', open);
          const value = open.value + middle.map((child) => child.value).join('') + '</SourceRef>';
          node.children.splice(i, closeIndex - i + 1,
            element(parse(value, open), 'mdxJsxTextElement', open.position));
        }
      }
      if (node.type !== 'html' || !/^\s*<SourceRef\b/.test(node.value) || index === undefined || !parent) return;
      parent.children[index] = element(parse(node.value, node), 'mdxJsxFlowElement', node.position);
    });
  };
}
