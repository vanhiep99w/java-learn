import { remarkTerminalSession } from '@vanhiep99w/docs-kit/terminal-session';
import { remarkCodeDiff } from '@vanhiep99w/docs-kit/code-diff';
import { remarkCodeWalkthrough } from '@vanhiep99w/docs-kit/code-walkthrough';
import { remarkProtocolExchange } from '@vanhiep99w/docs-kit/protocol-exchange';
import { remarkSpanWaterfall } from '@vanhiep99w/docs-kit/span-waterfall';

// Shared by the host compiler and focused descriptor checks.
export const learningPlugins = [
  remarkTerminalSession, remarkCodeDiff, remarkCodeWalkthrough,
  remarkProtocolExchange, remarkSpanWaterfall,
];
