// Step 2 (now backed by Supabase from Step 1) — hybrid search + LLM reply.
//   npm run chat

import { hybridSearch } from './search.js';
import { askLLM } from './llm.js';

const questions = [
  { q: 'do you have running shoes under $50?', opts: { maxPrice: 50 } },
  { q: 'something warm I can wear in winter?', opts: {} },
  { q: 'I need running shoes that are actually in stock', opts: { inStockOnly: true } },
  { q: 'do you sell laptops?', opts: {} },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const [i, { q, opts }] of questions.entries()) {
  // Free-tier MiniMax is rate-limited upstream — pace requests.
  if (i > 0) await sleep(5000);
  console.log(`\n=== Customer: ${q} ===`);
  const results = await hybridSearch(q, opts);
  console.log(
    `Retrieved ${results.length} product(s): ${results.map((r) => `#${r.id}`).join(', ') || 'none'}`
  );
  try {
    const reply = await askLLM(q, results);
    console.log(`Bot: ${reply}`);
  } catch (err) {
    console.log(`Bot: [LLM error: ${err.message.split('\n')[0]}]`);
  }
}
