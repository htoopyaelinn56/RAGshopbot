-- Step 1 schema for shop-bot. Run ONCE in Supabase SQL editor.
-- Two-table design:
--   products            = source of truth (name, description, price, stock).
--                         Any system (admin UI, POS, Shopify sync) can own it.
--   product_embeddings  = derived. ONE row per product, holds the vector.
--                         Rebuilt by `npm run index`. Never holds stock/price.
-- ON DELETE CASCADE: removing a product wipes its embedding automatically.

create extension if not exists vector;

-- 1. Source of truth.
drop table if exists product_embeddings cascade;
drop table if exists products cascade;

create table products (
  id          serial primary key,
  name        text    not null,
  description text    not null,
  price       numeric not null,
  stock       int     not null default 0,
  updated_at  timestamptz not null default now()
);

-- 2. Derived embeddings — one row per product.
create table product_embeddings (
  product_id   int primary key references products(id) on delete cascade,
  content      text        not null,       -- exact text that was embedded
  embedding    vector(384) not null,
  embedded_at  timestamptz not null default now()
);

-- 3. HNSW index for fast cosine similarity on the embeddings table.
create index product_embeddings_idx
  on product_embeddings using hnsw (embedding vector_cosine_ops);

-- 4. Hybrid search function — JOINs the two tables in one SQL statement.
--    Vector ranking from product_embeddings, filtering/data from products.
--    similarity = 1 - cosine_distance  (1.0 = identical, 0 = orthogonal).
create or replace function match_products (
  query_embedding vector(384),
  match_count     int     default 5,
  max_price       numeric default 1e9,
  in_stock_only   boolean default false
) returns table (
  id          int,
  name        text,
  description text,
  price       numeric,
  stock       int,
  similarity  float
)
language sql stable as $$
  select
    p.id,
    p.name,
    p.description,
    p.price,
    p.stock,
    1 - (e.embedding <=> query_embedding) as similarity
  from product_embeddings e
  join products p on p.id = e.product_id
  where p.price <= max_price
    and (not in_stock_only or p.stock > 0)
  order by e.embedding <=> query_embedding
  limit match_count;
$$;
