import { describe, expect, it } from 'vitest';
import { checkTransition, FUNNEL_RANK, freesSlot, isDowngrade, pickPromotions } from './index.js';

const t = (r: Parameters<typeof checkTransition>[0]) => checkTransition(r).ok;

describe('status machine', () => {
  it('ranks the funnel in contract order', () => {
    expect(FUNNEL_RANK.inbox).toBeLessThan(FUNNEL_RANK.active);
    expect(FUNNEL_RANK['draft-ready']).toBeLessThan(FUNNEL_RANK.applied);
    expect(FUNNEL_RANK.interviews).toBeLessThan(FUNNEL_RANK.offers);
  });

  it('marks downgrades only out of protected statuses', () => {
    expect(isDowngrade('draft-ready', 'on-deck')).toBe(true);
    expect(isDowngrade('interviews', 'applied')).toBe(true);
    expect(isDowngrade('applied', 'archived')).toBe(true);
    expect(isDowngrade('active', 'inbox')).toBe(false);
    expect(isDowngrade('applied', 'interviews')).toBe(false);
  });

  it('manual moves: humans follow MANUAL_MOVES, agents also obey no-downgrade', () => {
    expect(t({ from: 'inbox', to: 'active', actor: 'human', via: 'move' })).toBe(true);
    expect(t({ from: 'draft-ready', to: 'on-deck', actor: 'human', via: 'move' })).toBe(true);
    expect(t({ from: 'draft-ready', to: 'on-deck', actor: 'agent', via: 'move' })).toBe(false);
    expect(t({ from: 'interviews', to: 'applied', actor: 'schedule', via: 'move' })).toBe(false);
    expect(t({ from: 'draft-ready', to: 'applied', actor: 'human', via: 'move' })).toBe(false);
    expect(t({ from: 'active', to: 'held', actor: 'human', via: 'move' })).toBe(false);
    expect(t({ from: 'active', to: 'archived', actor: 'human', via: 'move', archiveReason: 'passed' })).toBe(false);
    expect(t({ from: 'archived', to: 'active', actor: 'human', via: 'move' })).toBe(true);
    expect(t({ from: 'archived', to: 'active', actor: 'agent', via: 'move' })).toBe(false);
  });

  it('pick (#105): any actor, active or held -> on-deck only; never out of on-deck or later; rescore keeps the pick', () => {
    for (const actor of ['human', 'agent', 'schedule'] as const) {
      expect(t({ from: 'active', to: 'on-deck', actor, via: 'pick' })).toBe(true);
      expect(t({ from: 'held', to: 'on-deck', actor, via: 'pick' })).toBe(true);
    }
    for (const from of ['inbox', 'draft-ready', 'applied', 'interviews', 'offers', 'archived'] as const)
      expect(t({ from, to: 'on-deck', actor: 'agent', via: 'pick' })).toBe(false);
    expect(t({ from: 'active', to: 'draft-ready', actor: 'human', via: 'pick' })).toBe(false);
    expect(t({ from: 'on-deck', to: 'held', actor: 'agent', via: 'score' })).toBe(false);
    expect(t({ from: 'on-deck', to: 'draft-ready', actor: 'agent', via: 'tailor' })).toBe(true);
    expect(freesSlot('active', 'on-deck')).toBe(true);
  });

  it('same status is a conflict', () => {
    expect(checkTransition({ from: 'active', to: 'active', actor: 'human', via: 'move' })).toMatchObject({ ok: false, code: 'conflict' });
  });

  it('archive: humans anywhere; automation out of protected only on rejection or a closed draft-ready', () => {
    expect(t({ from: 'offers', to: 'archived', actor: 'human', via: 'archive', archiveReason: 'withdrawn' })).toBe(true);
    expect(t({ from: 'active', to: 'archived', actor: 'agent', via: 'archive', archiveReason: 'closed' })).toBe(true);
    expect(t({ from: 'applied', to: 'archived', actor: 'agent', via: 'archive', archiveReason: 'rejected' })).toBe(true);
    expect(t({ from: 'draft-ready', to: 'archived', actor: 'schedule', via: 'archive', archiveReason: 'closed' })).toBe(true);
    expect(t({ from: 'applied', to: 'archived', actor: 'schedule', via: 'archive', archiveReason: 'closed' })).toBe(false);
    expect(t({ from: 'interviews', to: 'archived', actor: 'agent', via: 'archive', archiveReason: 'passed' })).toBe(false);
    expect(t({ from: 'active', to: 'archived', actor: 'human', via: 'archive' })).toBe(false);
  });

  it('inbox: forward only, rejection always archives', () => {
    expect(t({ from: 'draft-ready', to: 'applied', actor: 'agent', via: 'inbox' })).toBe(true);
    expect(t({ from: 'interviews', to: 'applied', actor: 'agent', via: 'inbox' })).toBe(false);
    expect(t({ from: 'applied', to: 'offers', actor: 'agent', via: 'inbox' })).toBe(true);
    expect(t({ from: 'interviews', to: 'archived', actor: 'agent', via: 'inbox', archiveReason: 'rejected' })).toBe(true);
    expect(t({ from: 'interviews', to: 'archived', actor: 'agent', via: 'inbox', archiveReason: 'closed' })).toBe(false);
  });

  it('tailor and submit', () => {
    expect(t({ from: 'active', to: 'draft-ready', actor: 'agent', via: 'tailor' })).toBe(true);
    expect(t({ from: 'held', to: 'draft-ready', actor: 'agent', via: 'tailor' })).toBe(false);
    expect(t({ from: 'draft-ready', to: 'applied', actor: 'human', via: 'submit' })).toBe(true);
    expect(t({ from: 'draft-ready', to: 'applied', actor: 'agent', via: 'submit' })).toBe(false);
  });

  it('score (lane F): never out of protected or on-deck, revives only rescorable archives', () => {
    expect(t({ from: 'inbox', to: 'held', actor: 'agent', via: 'score' })).toBe(true);
    expect(t({ from: 'draft-ready', to: 'archived', actor: 'agent', via: 'score', archiveReason: 'below_threshold' })).toBe(false);
    expect(t({ from: 'on-deck', to: 'archived', actor: 'agent', via: 'score', archiveReason: 'below_threshold' })).toBe(false);
    expect(t({ from: 'archived', to: 'active', actor: 'agent', via: 'score', fromArchiveReason: 'below_threshold' })).toBe(true);
    expect(t({ from: 'archived', to: 'active', actor: 'agent', via: 'score', fromArchiveReason: 'rejected' })).toBe(false);
  });

  it('slots and promotion picks', () => {
    expect(freesSlot('active', 'on-deck')).toBe(true);
    expect(freesSlot('held', 'active')).toBe(false);
    const held = [
      { id: 'a', total: 80, found_at: '2026-01-02' },
      { id: 'b', total: 90, found_at: '2026-01-03' },
      { id: 'c', total: 80, found_at: '2026-01-01' },
    ];
    expect(pickPromotions(held, 1, 3)).toEqual(['b', 'c']);
    expect(pickPromotions(held, 3, 3)).toEqual([]);
  });
});
