'use client';

import { useEffect, useId, useRef } from 'react';

/**
 * Mermaid keeps parser and configuration state globally. Rendering several
 * diagrams at the same time can corrupt that state and intermittently produce
 * Mermaid's generic "Syntax error in text" SVG for valid charts.
 */
let mermaidModule: Promise<typeof import('mermaid').default> | undefined;
let renderQueue: Promise<void> = Promise.resolve();

function loadMermaid() {
  mermaidModule ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({ startOnLoad: false });
    return mermaid;
  });

  return mermaidModule;
}

function renderChart(id: string, chart: string) {
  const render = renderQueue.then(async () => {
    const mermaid = await loadMermaid();
    return mermaid.render(id, chart);
  });

  // Keep the queue usable after an invalid diagram fails to render.
  renderQueue = render.then(
    () => undefined,
    () => undefined,
  );

  return render;
}

export function MermaidDiagram({ chart }: { chart: string }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  const safeId = `mermaid-${id.replace(/:/g, '')}`;

  useEffect(() => {
    if (!ref.current) return;
    let cancelled = false;

    renderChart(safeId, chart)
      .then(({ svg }) => {
        if (!cancelled && ref.current) {
          ref.current.innerHTML = svg;
        }
      })
      .catch((err) => {
        if (cancelled || !ref.current) return;
        const pre = document.createElement('pre');
        pre.className = 'text-sm text-red-500 whitespace-pre-wrap';
        pre.textContent = `Mermaid render error: ${err?.message ?? String(err)}`;
        ref.current.replaceChildren(pre);
      });

    return () => {
      cancelled = true;
    };
  }, [chart, safeId]);

  return <div ref={ref} className="my-6 flex justify-center overflow-x-auto" />;
}
