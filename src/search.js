// Hybrid search against Supabase + pgvector.
//   - Vector layer: embeddings.embedQuery() + pgvector cosine ordering.
//   - Structured layer: max_price / in_stock_only filtered inside the
//     match_products() SQL function (see sql/schema.sql).
// Same signature as the Step 0 in-memory version, so callers don't change.

import { embeddings } from './embed.js';
import { supabase } from './db.js';

export async function hybridSearch(
  query,
  { maxPrice = 1e9, inStockOnly = false, threshold = 0.35, k = 5 } = {}
) {
  const queryEmbedding = await embeddings.embedQuery(query);

  const { data, error } = await supabase.rpc('match_products', {
    query_embedding: queryEmbedding,
    match_count: k,
    max_price: maxPrice,
    in_stock_only: inStockOnly,
  });

  if (error) throw error;

  return data
    .filter((row) => row.similarity >= threshold)
    .map((row) => ({
      id: row.id,
      name: row.name,
      text: row.description,
      price: Number(row.price),
      stock: row.stock,
      score: row.similarity,
    }));
}
