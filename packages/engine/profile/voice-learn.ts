import { type OpContext, type OpInput, type OpOutput, VOICE_LEARN_SAMPLE_MAX_CHARS, VOICE_SAMPLES_MAX } from '@perfect-placement/contracts';
import type { ProfileDeps } from './deps.js';
import { OpError } from './errors.js';
import { deepEqual } from './json.js';
import { profileProposeDiff, VOICE_LEARNED_EVIDENCE } from './profile-ops.js';
import { getComponent, getCurrentVersion } from './versions.js';

/*
 * Learn voice (#76): the `voice` run reads the user's own writing (recent sent Gmail, read-only; LinkedIn
 * posts via Claude in Chrome when LinkedIn is live) and proposes style, traits and up to three short
 * samples through `profile.propose_voice`. Code refuses a sample that still carries someone else's details
 * and never applies the diff: only a human accepts it (`profile.apply_diff` from anyone else is human_only).
 */

/** Shortest sample worth keeping (a style exemplar, not a fragment). */
export const VOICE_LEARN_SAMPLE_MIN_CHARS = 40;

const CHECKS: Array<[RegExp, string]> = [
  [/[\w.+-]+@[\w-]+\.[\w.-]+/, 'an email address'],
  [/(?:\+?\d[\s().-]?){7,}\d/, 'a phone number'],
  [/\bhttps?:\/\/|\bwww\.|\b[\w-]+\.(?:com|io|ai|org|net|co)\b(?:\/\S*)?/i, 'a link'],
  [/(^|\s)@[A-Za-z][\w.]+/, 'an @handle'],
  [/^\s*(hi|hello|hey|dear|thanks|thank you|cheers)\s+[A-Z][a-z]+/im, 'a greeting or thanks to someone by name'],
  [/^\s*>/m, 'quoted text'],
  [/^\s*(on .+ wrote:|from:|to:|cc:|subject:)/im, 'an email header or quote'],
  [/[—–]/, 'an em or en dash'],
];

/** Why a sample cannot be kept, or null. */
export function sampleProblem(sample: string): string | null {
  const t = sample.trim();
  if (t.length < VOICE_LEARN_SAMPLE_MIN_CHARS) return `shorter than ${VOICE_LEARN_SAMPLE_MIN_CHARS} chars`;
  if (t.length > VOICE_LEARN_SAMPLE_MAX_CHARS) return `over ${VOICE_LEARN_SAMPLE_MAX_CHARS} chars`;
  for (const [re, what] of CHECKS) if (re.test(t)) return `has ${what}`;
  return null;
}

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function profileProposeVoice(
  deps: ProfileDeps,
  input: OpInput<'profile.propose_voice'>,
  ctx: OpContext,
): { output: OpOutput<'profile.propose_voice'>; eventIds: string[] } {
  const version = getCurrentVersion(deps.repos);
  if (!version) throw new OpError('conflict', 'no profile yet: onboard first');
  const voice = getComponent(deps.repos, version.id, 'voice')?.data_json ?? {};
  const samples = (input.samples ?? []).map((x) => x.trim());
  const traits = (input.traits ?? []).map((x) => x.trim().replace(/\s+/g, ' '));
  const problems = samples.flatMap((x, i) => {
    const p = sampleProblem(x);
    return p ? [`sample ${i + 1} ${p}`] : [];
  });
  for (const [i, t] of traits.entries()) if (/[—–]/.test(t)) problems.push(`trait ${i + 1} has an em or en dash`);
  if (input.style && /[—–]/.test(input.style)) problems.push('style has an em or en dash');
  if (problems.length) throw new OpError('invalid_input', `voice not proposed: ${problems.join('; ')}`, problems);

  // Kept samples first (the user's own picks), learned ones after, up to the cap.
  const kept = strList(voice.samples);
  const fresh = [...new Set(samples)].filter((x) => !kept.includes(x));
  const room = Math.max(0, VOICE_SAMPLES_MAX - kept.length);
  const added = fresh.slice(0, room);
  const after: Record<string, unknown> = {};
  if (added.length) after.samples = [...kept, ...added];
  if (input.style && input.style !== voice.style) after.style = input.style;
  if (traits.length && !deepEqual(traits, voice.traits)) after.traits = [...new Set(traits)];
  const sources = { gmail_sent: input.sources.gmail_sent ?? 0, linkedin_posts: input.sources.linkedin_posts ?? 0 };
  if (!Object.keys(after).length) return { output: { diff: null, dropped: fresh.length - added.length }, eventIds: [] };
  after.learned_from = sources;
  const before = Object.fromEntries(
    Object.keys(after)
      .filter((k) => k in voice)
      .map((k) => [k, voice[k]]),
  );
  const evidence = [
    VOICE_LEARNED_EVIDENCE,
    `${sources.gmail_sent} sent email${sources.gmail_sent === 1 ? '' : 's'} read`,
    `${sources.linkedin_posts} LinkedIn post${sources.linkedin_posts === 1 ? '' : 's'} read`,
  ];
  const r = profileProposeDiff(deps, { component: 'voice', before, after, evidence }, ctx);
  return { output: { diff: r.output.diff, dropped: fresh.length - added.length }, eventIds: r.eventIds };
}
