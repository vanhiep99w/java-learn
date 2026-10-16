import type { ReactNode } from 'react';
import { RootProvider } from 'fumadocs-ui/provider/next';
import './globals.css';
import { DocsSourceExplorer } from '@/components/source-explorer';

export const metadata = {
  title: 'Java Learning',
  description: 'Tài liệu học Java tiếng Việt — Java Core, JVM, Collections, Concurrency, Design Patterns, Spring',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="vi" suppressHydrationWarning>
      <body suppressHydrationWarning>
        <RootProvider search={{ options: { type: 'static' } }}>
          <DocsSourceExplorer>{children}</DocsSourceExplorer>
        </RootProvider>
      </body>
    </html>
  );
}
