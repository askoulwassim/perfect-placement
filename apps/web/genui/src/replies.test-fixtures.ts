/*
 * Recorded Ask replies (what a model emits after reading askSystemPrompt() plus id context).
 * Written root-first, the order the generated prompt asks for. Ids are fixture ids only.
 */
export interface Scenario {
  id: string;
  ask: string;
  /** Keywords that route a typed question to this scenario in the scripted Ask. */
  match: readonly string[];
  openui: string;
}

export const SCENARIOS: readonly Scenario[] = [
  {
    id: 'best-fit',
    ask: 'Why is Linear my best fit?',
    match: ['linear', 'fit', 'why'],
    openui: [
      'root = Reply([t, g1, g2])',
      't = Text("Linear scores high and you have a warm path")',
      'g1 = Group("Linear", [r, s])',
      'g2 = Group("People", [p1, p2])',
      'r = RoleCard("linear_product-lead-insights")',
      's = ScoreRadar("linear_product-lead-insights")',
      'p1 = ContactCard("ct_0001", "linear_product-lead-insights")',
      'p2 = ContactCard("ct_0003", "linear_product-lead-insights")',
    ].join('\n'),
  },
  {
    id: 'interviews',
    ask: 'What is in interviews?',
    match: ['interview'],
    openui: [
      'root = Reply([t, r1, r2])',
      't = Text("Two roles in interviews")',
      'r1 = RoleCard("figma_staff-pm-data-platform")',
      'r2 = RoleCard("ramp_principal-pm-ai-agents")',
    ].join('\n'),
  },
  {
    id: 'profile',
    ask: 'What changed in my profile?',
    match: ['profile', 'changed', 'diff'],
    openui: [
      'root = Reply([t, d1, d2])',
      't = Text("Two changes wait for you")',
      'd1 = ProfileDiff("pd_0001")',
      'd2 = ProfileDiff("pd_0002")',
    ].join('\n'),
  },
  {
    id: 'compare',
    ask: 'Compare Figma and Ramp',
    match: ['compare', 'figma', 'ramp'],
    openui: [
      'root = Reply([g1, g2])',
      'g1 = Group("Figma", [r1, s1])',
      'g2 = Group("Ramp", [r2, s2])',
      'r1 = RoleCard("figma_staff-pm-data-platform")',
      's1 = ScoreRadar("figma_staff-pm-data-platform")',
      'r2 = RoleCard("ramp_principal-pm-ai-agents")',
      's2 = ScoreRadar("ramp_principal-pm-ai-agents")',
    ].join('\n'),
  },
  {
    id: 'top-active',
    ask: 'Top active roles',
    match: ['top', 'active', 'best'],
    openui: [
      'root = Reply([t, r1, r2, r3])',
      't = Text("Three live fits")',
      'r1 = RoleCard("datadog_staff-pm-data-pipelines")',
      'r2 = RoleCard("vercel_staff-pm-ai-sdk")',
      'r3 = RoleCard("retool_principal-pm-workflows")',
    ].join('\n'),
  },
];

export function routeAsk(query: string): Scenario {
  const q = query.toLowerCase();
  let best = SCENARIOS[0] as Scenario;
  let bestHits = 0;
  for (const s of SCENARIOS) {
    const hits = s.match.filter((m) => q.includes(m)).length;
    if (hits > bestHits) {
      best = s;
      bestHits = hits;
    }
  }
  return best;
}
