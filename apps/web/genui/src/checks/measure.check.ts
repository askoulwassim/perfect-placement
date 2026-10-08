import { describe, expect, test } from 'vitest';
import { fixtureData } from '../data.js';
import { askSystemPrompt } from '../library.js';
import { estimateMs, measureScenario, parseReply, promptOverhead } from '../measure.js';
import { SCENARIOS } from '../replies.js';

const data = fixtureData();
const results = SCENARIOS.map((s) => measureScenario(s, data));
const pct = (x: number) => `${Math.round(x * 100)}%`;
const sum = (f: (r: (typeof results)[number]) => number) => results.reduce((a, r) => a + f(r), 0);

describe('measure: tokens and latency (o200k_base proxy tokenizer)', () => {
  test('every recorded reply parses cleanly against the library', () => {
    for (const s of SCENARIOS) expect(() => parseReply(s.openui)).not.toThrow();
  });

  test('OpenUI Lang is smaller than equivalent JSON in every scenario, ids and inline', () => {
    for (const r of results) {
      expect(r.tokens.openuiRef).toBeLessThan(r.tokens.jsonRef);
      expect(r.tokens.openuiInline).toBeLessThan(r.tokens.jsonInline);
    }
  });

  test('ids beat inline data, in both formats', () => {
    for (const r of results) {
      expect(r.tokens.openuiRef).toBeLessThan(r.tokens.openuiInline);
      expect(r.tokens.jsonRef).toBeLessThan(r.tokens.jsonInline);
    }
  });

  test('a card renders before the stream ends', () => {
    for (const r of results) {
      expect(r.firstCard.openui).toBeGreaterThan(0);
      expect(r.firstCard.openui).toBeLessThan(r.tokens.openuiRef);
    }
  });

  test('report', () => {
    const rows = results.map(
      (r) =>
        `| ${r.id} | ${r.tokens.openuiRef} | ${r.tokens.jsonRef} | ${pct(r.saving.ref)} | ${r.tokens.openuiInline} | ${r.tokens.jsonInline} | ${pct(r.saving.inline)} | ${r.tokens.tupleRef} | ${r.firstCard.openui} / ${r.firstCard.json} | ${r.parseMs.toFixed(2)} |`,
    );
    const tot = {
      oR: sum((r) => r.tokens.openuiRef),
      jR: sum((r) => r.tokens.jsonRef),
      oI: sum((r) => r.tokens.openuiInline),
      jI: sum((r) => r.tokens.jsonInline),
    };
    const p = promptOverhead(askSystemPrompt());
    const avgFirst = { o: sum((r) => r.firstCard.openui) / results.length, j: sum((r) => r.firstCard.json) / results.length };
    const avgFull = { o: tot.oR / results.length, j: tot.jR / results.length, oI: tot.oI / results.length, jI: tot.jI / results.length };
    const report = [
      '| scenario | OpenUI ids | JSON ids | saved | OpenUI inline | JSON inline | saved | JSON tuple ids | first card tok (OpenUI / JSON) | parse ms (all chunks) |',
      '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
      ...rows,
      `| **total** | ${tot.oR} | ${tot.jR} | ${pct(1 - tot.oR / tot.jR)} | ${tot.oI} | ${tot.jI} | ${pct(1 - tot.oI / tot.jI)} | ${sum((r) => r.tokens.tupleRef)} | | ${sum((r) => r.parseMs).toFixed(2)} |`,
      '',
      `ids vs inline (OpenUI): ${pct(1 - tot.oR / tot.oI)} fewer tokens`,
      `system prompt: OpenUI ${p.openui} tok, JSON-schema ${p.json} tok`,
      `est. first card (600 ms TTFT, 60 tok/s): OpenUI ${Math.round(estimateMs(avgFirst.o))} ms, JSON ${Math.round(estimateMs(avgFirst.j))} ms`,
      `est. full reply: OpenUI ids ${Math.round(estimateMs(avgFull.o))} ms, JSON ids ${Math.round(estimateMs(avgFull.j))} ms, OpenUI inline ${Math.round(estimateMs(avgFull.oI))} ms, JSON inline ${Math.round(estimateMs(avgFull.jI))} ms`,
    ].join('\n');
    console.log(`\n${report}\n`);
    console.log(results[0]?.text.tupleRef);
    expect(p.openui).toBeGreaterThan(0);
  });
});
