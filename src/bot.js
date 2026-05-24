// Step 3 + Step 4 polish — Telegram bot.
// Flow per message:
//   1. LLM extracts {maxPrice, inStockOnly} from the question.
//   2. Hybrid search runs with those filters.
//   3. If retrieval is empty -> short-circuit, no LLM reply call.
//   4. Otherwise, LLM writes the grounded reply.
// Both LLM calls are wrapped in withRateRetry (one delayed retry on 429).
//   npm run bot

import 'dotenv/config';
import { Telegraf } from 'telegraf';
import { hybridSearch } from './search.js';
import { askLLM, extractFilters, withRateRetry } from './llm.js';

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set in .env');

const bot = new Telegraf(token);

bot.start((ctx) =>
  ctx.reply(
    "Hi! I'm a shop assistant. Ask me about our clothing — try things like\n" +
    "  • \"something warm for winter\"\n" +
    "  • \"running shoes under $50\"\n" +
    "  • \"a dress for a wedding\""
  )
);

bot.help((ctx) =>
  ctx.reply("Just send me a message describing what you're looking for.")
);

bot.on('text', async (ctx) => {
  const question = ctx.message.text?.trim();
  if (!question) return;

  try {
    await ctx.sendChatAction('typing');

    // 1. Filter extraction.
    const opts = await withRateRetry(() => extractFilters(question));

    // 2. Hybrid search with extracted filters.
    const products = await hybridSearch(question, opts);
    console.log(
      `[bot] q="${question}" filters=${JSON.stringify(opts)} ` +
      `retrieved=${products.length}: ${
        products.map((p) => `#${p.id}(s=${p.score.toFixed(2)})`).join(', ') || 'none'
      }`
    );

    // 3. Empty -> short-circuit, skip the reply LLM call.
    if (products.length === 0) {
      await ctx.reply("Sorry, we don't have anything matching that. We sell clothing, shoes and accessories — try asking about those!");
      return;
    }

    // 4. Generate the grounded reply.
    await ctx.sendChatAction('typing');
    const reply = await withRateRetry(() => askLLM(question, products));

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
