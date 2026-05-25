// Telegram bot entry point.
// Flow per message:
//   1. interpretMessage (LLM) rewrites the query using chat memory and
//      extracts {maxPrice, inStockOnly}.
//   2. Hybrid search runs against Supabase with those filters.
//   3. askLLM (LLM) writes a grounded reply using retrieved products
//      AND the shop info loaded from about_shop.md.
// Both LLM calls are wrapped in withRateRetry (one delayed retry on
// transient errors / rate limits).
//
//   npm run bot

import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { hybridSearch } from './search.js';
import { askLLM, interpretMessage, withRateRetry } from './llm.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set in .env');

const bot = new Telegraf(token);

// Per-chat conversation history. In-memory only; resets on restart.
// Keys: chat.id  -> Values: array of {role, content} alternating user/assistant.
const histories = new Map();
const MAX_HISTORY = 6; // 3 user/assistant turn pairs

bot.start((ctx) => {
  histories.delete(ctx.chat.id); // fresh start clears memory
  return ctx.reply(
    "Hey there! Welcome to the shop. I'd love to help you find something — " +
    "clothing, shoes, accessories, whatever you're after. " +
    "Or if you'd like to know about shipping, returns, sizing, or our policies, " +
    "just ask. What can I help you with today?"
  );
});

bot.help((ctx) =>
  ctx.reply("Just send me a message describing what you're looking for.")
);

bot.on('text', async (ctx) => {
  const question = ctx.message.text?.trim();
  if (!question) return;

  try {
    await ctx.sendChatAction('typing');

    // Fetch this user's recent conversation (last 3 turns) once.
    const history = histories.get(ctx.chat.id) ?? [];

    // 1. Interpret — rewrites follow-ups like "cheaper ones" using prior
    //    turns so the search query is self-contained, AND extracts maxPrice
    //    / inStockOnly. Returns {searchQuery, maxPrice?, inStockOnly?}.
    const { searchQuery, ...opts } = await withRateRetry(() =>
      interpretMessage(question, history)
    );

    // 2. Hybrid search runs on the REWRITTEN searchQuery — not the raw user
    //    text — so embeddings benefit from context too.
    const products = await hybridSearch(searchQuery, opts);
    console.log(
      `[bot] q="${question}" -> search="${searchQuery}" filters=${JSON.stringify(opts)} ` +
      `retrieved=${products.length}: ${
        products.map((p) => `#${p.id}(s=${p.score.toFixed(2)})`).join(', ') || 'none'
      }`
    );

    // (No empty-results short-circuit anymore — shop-info questions
    // legitimately return 0 products and still need an LLM reply using
    // the SHOP INFO baked into the system prompt.)

    // 3. Generate the grounded reply, with conversation memory.
    await ctx.sendChatAction('typing');
    const reply = await withRateRetry(() => askLLM(question, products, history));

    // Append this turn and trim to the most recent MAX_HISTORY messages.
    history.push({ role: 'user', content: question });
    history.push({ role: 'assistant', content: reply });
    while (history.length > MAX_HISTORY) history.shift();
    histories.set(ctx.chat.id, history);

    try {
      await ctx.reply(reply, { parse_mode: 'Markdown' });
    } catch {
      await ctx.reply(reply);
    }
  } catch (err) {
    console.error('handler error:', err?.message ?? err);
    const msg = err?.status === 429
      ? "I'm getting too many requests right now. Try again in a few seconds?"
      : "Sorry, something went wrong on my end. Please try again.";
    await ctx.reply(msg);
  }
});

bot.catch((err, ctx) => {
  console.error(`[bot.catch] ${ctx?.updateType ?? 'unknown'}:`, err?.message ?? err);
  ctx?.reply("Sorry, something went wrong. Please try again.").catch(() => {});
});

const me = await bot.telegram.getMe();
console.log(`Bot launched as @${me.username} (id=${me.id}). Press Ctrl+C to stop.`);

bot.launch();
process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
