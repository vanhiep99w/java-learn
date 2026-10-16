import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { visit } from 'unist-util-visit';
import { projectRoot, readDocuments } from '../scripts/build-source-examples.mjs';

const documents = await readDocuments(resolve(projectRoot, 'content/docs'));
const diagrams = documents.flatMap((document) => {
  const result = [];
  visit(document.tree, 'code', (node) => {
    if (node.lang === 'd2') result.push({ path: document.path, node });
  });
  return result;
});

function diagram(path, signature) {
  const matches = diagrams.filter((entry) => entry.path === path && entry.node.value.includes(signature));
  assert.equal(matches.length, 1, `${path}: expected one diagram matching ${signature}`);
  return matches[0].node.value;
}

function edges(source) {
  return new Set([...source.matchAll(/^(\w+) -> (\w+)(?=\s|:|$)/gm)].map((match) => `${match[1]} -> ${match[2]}`));
}

test('D2 sources contain no leftover ASCII box/tree scaffolding', () => {
  for (const { path, node } of diagrams) {
    assert.doesNotMatch(node.value, /[\u2500-\u257f]/u, `${path}:${node.position.start.line}: model the relationship as nodes/edges, not ASCII fragments`);
  }
});

test('Throwable diagram preserves actual inheritance, not merged ASCII columns', () => {
  const source = diagram('fundamentals/exception-handling.md', 'object: Object');
  assert.deepEqual(edges(source), new Set([
    'object -> throwable', 'throwable -> error', 'throwable -> exception',
    'error -> vmError', 'error -> linkage', 'vmError -> outOfMemory', 'vmError -> stackOverflow',
    'exception -> runtime', 'exception -> io', 'exception -> sql', 'exception -> interrupted',
    'runtime -> nullPointer', 'runtime -> illegalArgument', 'runtime -> indexOutOfBounds', 'runtime -> classCast',
    'io -> fileNotFound',
  ]));
  assert.match(source, /outOfMemory: OutOfMemoryError/);
  assert.match(source, /stackOverflow: StackOverflowError/);
  assert.match(source, /indexOutOfBounds: IndexOutOfBoundsException/);
  assert.match(source, /fileNotFound: FileNotFoundException/);
});

test('servlet and parent contexts have the intended direct children', () => {
  const servlet = edges(diagram('spring/dispatcher-servlet.md', 'container: "Servlet container"'));
  assert.ok(servlet.has('container -> root'));
  assert.ok(servlet.has('container -> servlet'));
  assert.ok(servlet.has('child -> root'));
  const parent = edges(diagram('spring/spring-ioc-container.md', 'parent: "Parent ApplicationContext"'));
  assert.deepEqual(parent, new Set([
    'parent -> shared', 'parent -> web', 'parent -> admin', 'web -> webBeans', 'admin -> adminBeans',
  ]));
});

test('independent comparison/dependency roots are not children of the first item', () => {
  assert.equal(edges(diagram('spring/filter-va-interceptor.md', 'filter: "Filter\\n')).size, 0);
  const dependencies = edges(diagram('spring/spring-boot-autoconfiguration.md', 'web: WebMvcAutoConfiguration'));
  assert.ok(dependencies.has('web -> dispatcher'));
  assert.ok(dependencies.has('jpa -> hibernate'));
  assert.ok(!dependencies.has('web -> jpa'));
});

test('reactive transaction manager is not a PlatformTransactionManager implementation', () => {
  const relationships = edges(diagram('spring/spring-transaction.md', 'blocking: "PlatformTransactionManager'));
  assert.ok(relationships.has('reactive -> r2dbc'));
  assert.ok(!relationships.has('blocking -> r2dbc'));
});

test('transaction summary is a sequential flow rather than a star-shaped tree', () => {
  assert.deepEqual(edges(diagram('spring/spring-transaction.md', 'proxy: "1. @Transactional')), new Set([
    'proxy -> metadata', 'metadata -> transaction', 'transaction -> connection',
    'connection -> repository', 'repository -> finish', 'finish -> cleanup',
  ]));
});

test('JVM overview separates loading from execution, preserving cold and JIT paths', () => {
  const loading = diagram('jvm/jvm-architecture.md', 'loader: "ClassLoader\\nload / link / initialize"');
  assert.deepEqual(edges(loading), new Set(['source -> bytecode', 'bytecode -> loader', 'loader -> data']));
  const execution = diagram('jvm/jvm-architecture.md', 'cpu: "CPU\\nchạy JVM interpreter');
  assert.match(execution, /^grid-columns: 2/m);
  assert.deepEqual(edges(execution), new Set([
    'interpreter -> cpu', 'interpreter -> jit', 'jit -> cache', 'cache -> cpu',
  ]));
});

test('compact JVM execution grid connects adjacent cells without crossing nodes', () => {
  const execution = diagram('jvm/jvm-architecture.md', 'cpu: "CPU\\nchạy JVM interpreter');
  const ids = [...execution.matchAll(/^(\w+): "/gm)].map((match) => match[1]);
  const cells = new Map(ids.map((id, index) => [id, [index % 2, Math.floor(index / 2)]]));
  for (const edge of edges(execution)) {
    const [from, to] = edge.split(' -> ');
    const [x1, y1] = cells.get(from), [x2, y2] = cells.get(to);
    assert.equal(Math.abs(x1 - x2) + Math.abs(y1 - y2), 1, edge);
  }
});

test('Condition.signal moves t4 to sync tail, not directly into lock ownership', () => {
  const before = diagram('concurrency/aqs-deep-dive.md', 't4: "Condition queue\\nt4"');
  const after = diagram('concurrency/aqs-deep-dive.md', 'spacer1: ""');
  assert.match(before, /^head <-> t2 <-> t3$/m);
  assert.match(before, /^t4 -> t5 -> nil$/m);
  assert.match(after, /^head <-> t2 <-> t3 <-> t4$/m);
  assert.match(after, /^t3: "t3: SIGNAL"$/m);
  assert.match(after, /^t5 -> nil$/m);
});

test('grids explicitly fill rows before columns, so folded paths do not cross other cells', () => {
  for (const { path, node } of diagrams) {
    const columns = /^grid-columns: (\d+)$/m.exec(node.value);
    if (!columns || Number(columns[1]) < 2) continue;
    const rows = /^grid-rows: (\d+)$/m.exec(node.value);
    assert.ok(rows, `${path}:${node.position.start.line}: grid-rows must be explicit`);
    assert.ok(rows.index < columns.index, `${path}:${node.position.start.line}: declare grid-rows before grid-columns for row-major filling`);
    const cells = [...node.value.matchAll(/^\w+:/gm)].length;
    assert.equal(Number(rows[1]), Math.ceil(cells / Number(columns[1])), path);
  }
});
