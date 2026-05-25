# RAG Shop Bot

A Telegram bot that answers customer questions about an online clothing shop, grounded in a real product catalog and shop policies. Built on hybrid vector + structured search — meaning matches (vector) AND exact filters like price/stock (SQL) in a single Postgres query.

The bot can handle:

- **Product questions** — *"do you have running shoes under $50?"*, *"something warm for winter that's in stock"*, *"a dress for a wedding"*
- **Follow-ups with memory** — *"anything cheaper?"* after a shoe list correctly stays in the shoe category and applies the price constraint
- **Shop questions** — *"what are your shipping rates?"*, *"do you do returns?"*, *"what's your phone number?"*
- **Off-topic** — politely declines without inventing answers

It never invents products, prices, stock, or shop policies. If nothing fits, it says so.

---

## How a message flows

```
User on Telegram
   │
   │  "anything cheaper than 40?"
   ▼
┌──────────────────────────────────────────────────────────────┐
│ 1. interpretMessage  (LLM #1 — Gemini)                       │
│    Reads the message + last 3 turns of chat memory.          │
│    Output: { searchQuery: "cheaper summer wear",             │
│             maxPrice: 40 }                                   │
│    "cheaper" alone is meaningless — memory bridges it.       │
└──────────────────────────────────────────────────────────────┘
   │
   ▼
┌──────────────────────────────────────────────────────────────┐
│ 2. Hybrid search  (Supabase)                                 │
│    a) Embed "cheaper summer wear" locally (Xenova model).    │
│    b) Call match_products() RPC — ONE SQL statement that:    │
│         - ranks product_embeddings by cosine distance        │
│         - JOINs to products (name/price/stock)               │
│         - filters: price ≤ 40 AND (in_stock if asked)        │
│         - returns top 5                                      │
└──────────────────────────────────────────────────────────────┘
   │
   ▼
┌──────────────────────────────────────────────────────────────┐
│ 3. askLLM  (LLM #2 — Gemini)                                 │
│    Inputs: system prompt + SHOP INFO + history +             │
│            current question + the 5 retrieved products       │
│    Does a relevance check: skips items that don't actually   │
│    fit (e.g. wool beanie surfaced for "summer").             │
│    Formats reply as bullets with **#ID Name — $price**.      │
└──────────────────────────────────────────────────────────────┘
   │
   │  Friendly grounded reply
   ▼
User on Telegram
```

Two LLM calls per message. One embedding (local, free). One SQL round-trip.

---

## The key design decision: two-table schema

The handoff principle was *"embed only the descriptive text — never embed mutable data like price or stock"*. We took this further by splitting into two tables:

```
products                       product_embeddings
├─ id (PK)                     ├─ product_id (PK, FK → products.id, CASCADE)
├─ name                        ├─ content       (the text that was embedded)
├─ description                 ├─ embedding     (VECTOR(384))
├─ price                       └─ embedded_at
├─ stock
└─ updated_at
```

Why this matters:

- **Source of truth is just the catalog.** Any system (admin UI, POS, Shopify sync) can own `products` without knowing anything about embeddings.
- **Re-embedding is structurally impossible to confuse with stock updates.** Price/stock changes only touch `products`. Description changes touch both. There's no "row with embedding + stock" temptation.
- **Embedding pipeline can evolve independently** — swap models, change vector dimension, A/B test — none of it touches the live catalog.

The `match_products()` SQL function joins both tables and applies all filtering in one statement, so from Node's perspective it's still one query.

---

## Stack

| Layer | Pick | Why |
|---|---|---|
| Embeddings | `Xenova/all-MiniLM-L6-v2` via `@langchain/community` | 384-dim, runs locally, no API key, ~25 MB one-time download |
| Vector store | Supabase Postgres + `pgvector` (HNSW index) | Free tier, no local install, vector ops + structured filters in one query |
| LLM | Google AI Studio Gemini 2.5 Flash Lite | Free tier, fast, OpenAI-compatible endpoint |
| LLM client | `@langchain/openai` (`ChatOpenAI`) | Works against any OpenAI-compatible endpoint — provider is just an env var |
| Bot framework | `telegraf` | Cleaner ergonomics than `node-telegram-bot-api` |
| Language | Node.js (ESM) | — |

The LLM is interchangeable: set `LLM_BASE_URL` to OpenRouter, OpenAI, Anthropic-compat, Groq, local Ollama, etc. and the code doesn't change.

---

## File map

| File | Role |
|---|---|
| `src/bot.js` | Telegram entry point. Per-chat memory (last 3 turns). Orchestrates interpret → search → reply. |
| `src/llm.js` | LLM client config + `interpretMessage()` (query rewriting + filter extraction) + `askLLM()` (grounded reply) + `withRateRetry()` helper. Loads `about_shop.md` into the system prompt at startup. |
| `src/search.js` | `hybridSearch(query, opts)` — embeds the query and calls the `match_products` Supabase RPC. |
| `src/embed.js` | Single shared `HuggingFaceTransformersEmbeddings` instance (same model at indexing and querying — important). |
| `src/db.js` | Supabase client (uses service_role key, server-side only). |
| `src/index.js` | One-time indexer. Wipes both tables, re-inserts the catalog, embeds every product. Run with `npm run index`. |
| `src/products.js` | 100-item seed catalog. Dev-only — in production this would be replaced by reading from a real source of truth. |
| `about_shop.md` | Shop policies, hours, shipping, contact, etc. Loaded into the system prompt verbatim. Edit + restart to update. |
| `sql/schema.sql` | One-time DB setup: `pgvector` extension, both tables, HNSW index, `match_products()` function. |
| `.env.example` | Template for required env vars. |

---

## Setup

You need free accounts on **Supabase**, **Google AI Studio**, and **Telegram** (with BotFather access).

### 1. Clone & install

```bash
git clone https://github.com/LinSwanSaung/RAGshopbot.git
cd RAGshopbot
npm install --legacy-peer-deps
```

### 2. Supabase project

- Create a project at [supabase.com/dashboard](https://supabase.com/dashboard).
- **SQL Editor → New query** → paste `sql/schema.sql` → **Run**. Creates the tables, vector index, and `match_products()` function.
- Grab your **Project URL** and the **`service_role`** key from Settings → API.

### 3. Google AI Studio key

- Get an API key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey) — "Create API key in new project".
- Keep it private — Google scans public locations for leaked keys and auto-suspends projects.

### 4. Telegram bot

- Message [@BotFather](https://t.me/BotFather) on Telegram, send `/newbot`, follow prompts.
- Copy the token it gives you.

### 5. `.env` file

Create `.env` in the project root:

```env
LLM_API_KEY=AIzaSy_your_google_key
LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
LLM_MODEL=gemini-2.5-flash-lite

SUPABASE_URL=https://your-ref.supabase.co
SUPABASE_SERVICE_KEY=eyJ_your_service_role_key

TELEGRAM_BOT_TOKEN=1234567890:AAH_your_bot_token
```

### 6. Edit `about_shop.md`

Replace the placeholder shop info with your real shop's details. The bot uses this verbatim when answering shop questions.

### 7. Seed the database

```bash
npm run index
```

First run downloads the ~25 MB embedding model. Output should end with `Indexed 100 products + 100 embeddings.`

### 8. Run the bot

```bash
npm run bot
```

Should print `Bot launched as @yourbot (id=...)`. Leave the terminal open. Message the bot on Telegram.

---

## Customizing

- **Replace the catalog:** edit `src/products.js` and re-run `npm run index`. Or replace `src/index.js` with a script that reads from a CSV/JSON/API.
- **Change the shop info:** edit `about_shop.md`. Restart the bot to reload.
- **Swap the LLM provider:** change `LLM_BASE_URL` + `LLM_MODEL` + `LLM_API_KEY` in `.env`. The code is provider-agnostic — works with OpenRouter, OpenAI, Anthropic's compat endpoint, Groq, local Ollama, etc.
- **Tune retrieval:** in `src/search.js`, change `threshold` (default 0.35 — higher = stricter), `k` (default 5 — how many candidates returned).
- **Change reply tone:** edit `SYSTEM_PROMPT` in `src/llm.js`.
- **More chat memory:** in `src/bot.js`, raise `MAX_HISTORY` (default 6 messages = 3 turn pairs). Each extra turn adds tokens to every reply call.

---

## Common gotchas

- **`fetch failed` on first message** — transient. The retry helper handles it automatically.
- **`429 Provider returned error`** — Gemini free tier limits (~30 RPM for `flash-lite`, fewer for `flash`). Wait a minute or top up Google AI Studio.
- **`401 Unauthorized` from Supabase** — wrong key. Must be the `service_role` legacy key, not `anon` or publishable.
- **Bot launches but messages never arrive** — another instance is polling Telegram with the same token. Only one process can `getUpdates` at a time. Stop the duplicate.
- **`Cannot find module 'sharp'`** — `npm install` had a network hiccup downloading native binaries. Re-run `npm install sharp --legacy-peer-deps`.
