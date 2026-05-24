// LangChain ChatOpenAI pointed at OpenRouter (OpenAI-compatible endpoint).
//
// Exports:
//   chat            — main chat model for grounded replies
//   askLLM(q, ps)   — runs the customer reply prompt
//   extractFilters  — Step-4 polish: LLM-driven {maxPrice, inStockOnly} extraction
//   withRateRetry   — one-shot delayed retry on 429 (rate-limit) errors

import 'dotenv/config';
import { ChatOpenAI } from '@langchain/openai';

const apiKey = process.env.OPENROUTER_API_KEY;
const model = process.env.OPENROUTER_MODEL ?? 'minimax/minimax-m2.5:free';

if (!apiKey) {
  throw new Error('OPENROUTER_API_KEY is not set in .env');
}

const openrouterConfig = {
  baseURL: 'https://openrouter.ai/api/v1',
  defaultHeaders: {
    'HTTP-Referer': 'http://localhost',
    'X-Title': 'shop-bot',
  },
};

// maxRetries:1 -> fail fast on 429 so the bot doesn't hang past Telegraf's 90s timeout.
// withRateRetry() below adds our own controlled retry on top.
export const chat = new ChatOpenAI({
  apiKey, model,
  temperature: 0.3,
  maxRetries: 1,
  configuration: openrouterConfig,
});

// Separate instance for filter extraction: deterministic (temp=0).
const extractor = new ChatOpenAI({
  apiKey, model,
  temperature: 0,
  maxRetries: 1,
  configuration: openrouterConfig,
});

// --- Reply generation -------------------------------------------------------

const SYSTEM_PROMPT = `You are a helpful assistant for an online shop.
Answer the customer ONLY using the products listed under "Relevant products".
If none of the listed products match what they're asking for, say we don't
have it — never invent products, prices, or stock numbers.
Keep replies short and friendly. Quote price and stock when relevant.`;

function formatProducts(products) {
  if (products.length === 0) return '(none)';
  return products
    .map(
      (p) =>
        `- #${p.id} ${p.name} — ${p.text}. Price: $${p.price}. Stock: ${p.stock}.`
    )
    .join('\n');
}

export async function askLLM(question, products) {
  const userMessage = `Customer question: ${question}

Relevant products:
${formatProducts(products)}`;

  const response = await chat.invoke([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userMessage },
  ]);

  return response.content;
}

// --- Filter extraction (Step 4 #1) -----------------------------------------

const EXTRACT_SYSTEM = `You are a JSON-only parser. Output ONE JSON object on a single line. No prose, no markdown, no code fences.

Read the customer message and extract any of these OPTIONAL fields:
  - maxPrice (number): the customer's maximum budget in dollars.
    Trigger words: "under", "below", "less than", "max", "up to", "cheaper than", "<".
  - inStockOnly (boolean, true only): true if the customer requires items currently available.
    Trigger words: "in stock", "available", "have it", "can buy now".

If the message has no such constraint, output an empty object: {}.

Examples:
  Input: "running shoes under $50"
  Output: {"maxPrice": 50}

  Input: "in-stock dresses please"
  Output: {"inStockOnly": true}

  Input: "show me dresses below 100 that are available"
  Output: {"maxPrice": 100, "inStockOnly": true}

  Input: "do you have warm sweaters"
  Output: {}`;

export async function extractFilters(question) {
  const response = await extractor.invoke([
    { role: 'system', content: EXTRACT_SYSTEM },
    { role: 'user', content: question },
  ]);

  let raw = String(response.content).trim();
  raw = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return {};

  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return {};
  }

  const opts = {};
  if (typeof parsed.maxPrice === 'number' && parsed.maxPrice > 0) {
    opts.maxPrice = parsed.maxPrice;
  }
  if (parsed.inStockOnly === true) {
    opts.inStockOnly = true;
  }
  return opts;
}

// --- Rate-limit retry helper (Step 4 #3) -----------------------------------

export async function withRateRetry(fn, { delayMs = 3000 } = {}) {
  try {
    return await fn();
  } catch (err) {
    if (err?.status !== 429) throw err;
    console.log(`[retry] 429 — waiting ${delayMs}ms then retrying once`);
    await new Promise((r) => setTimeout(r, delayMs));
    return await fn();
  }
}
