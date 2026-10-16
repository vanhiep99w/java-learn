import { pageSchema } from 'fumadocs-core/source/schema';
import { z } from 'zod';

// Fumadocs strips unknown frontmatter fields. Keep d2Layout available to remarkD2.
export const docsPageSchema = pageSchema.extend({
  d2Layout: z.enum(['elk', 'dagre', 'tala']).optional(),
});
