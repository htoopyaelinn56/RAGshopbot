// Step 0 — standalone in-memory hybrid search demo (no DB).
// Kept as a fast smoke test for the embedding model. Step 1's search.js
// is the real path going forward; run `npm run chat` for that.

import { MemoryVectorStore } from 'langchain/vectorstores/memory';
import { Document } from '@langchain/core/documents';
import { products } from './products.js';
import { embeddings } from './embed.js';

console.log('Loading embedding model (Xenova/all-MiniLM-L6-v2)...');
console.log('First run downloads ~25MB; later runs are cached and fast.\n');

const docs = products.map(
  (p) =>
    new Document({
      pageContent: `${p.name}. ${p.text}`,
      metadata: { id: p.id, name: p.name, price: p.price, stock: p.stock },
    })
);
const store = await MemoryVectorStore.fromDocuments(docs, embeddings);
console.log(`Indexed ${docs.length} products in memory.\n`);

async function memorySearch(query, { maxPrice = Infinity, inStockOnly = false, threshold = 0.25, k = 5 } = {}) {
  const filter = (d) => {
    if (d.metadata.price > maxPrice) return false;
    if (inStockOnly && d.metadata.stock <= 0) return false;
    return true;
  };
  const raw = await store.similaritySearchWithScore(query, 50, filter);
  return raw
    .filter(([, s]) => s >= threshold)
    .slice(0, k)
    .map(([d, s]) => ({ ...d.metadata, score: s }));
}

function printResults(label, results) {
  console.log(`--- ${label} ---`);
  if (results.length === 0) console.log('  (no matches above threshold)');
  else for (const r of results) console.log(`  [${r.score.toFixed(3)}] #${r.id} ${r.name}  $${r.price}  stock=${r.stock}`);
  console.log();
}

printResults('Q: "comfy footwear for jogging"', await memorySearch('comfy footwear for jogging'));
printResults('Q: "running shoes under $50"', await memorySearch('running shoes', { maxPrice: 50 }));
printResults('Q: "running shoes in stock"', await memorySearch('running shoes', { inStockOnly: true }));
printResults('Q: "something warm for winter"', await memorySearch('something warm for winter'));
printResults('Q: "do you sell laptops?"', await memorySearch('do you sell laptops?'));
