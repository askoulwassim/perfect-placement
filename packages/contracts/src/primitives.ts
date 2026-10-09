import { z } from 'zod';

/**
 * Ids are TEXT.
 * - role: `<company-slug>_<title-slug>`, `-2`, `-3` suffix on collision.
 * - company: `<slug>`.
 * - everything else: `<prefix>_<ulid>`, prefixes in ID_PREFIX.
 */
export const Id = z.string().min(1);
export type Id = z.infer<typeof Id>;

export const ID_PREFIX = {
  profile_version: 'pv',
  profile_component: 'pc',
  profile_diff: 'pd',
  score: 'sc',
  event: 'ev',
  application: 'ap',
  contact: 'ct',
  contact_link: 'cl',
  outreach: 'or',
  interview: 'iv',
  decision: 'dc',
  run: 'rn',
  onboard_session: 'ob',
} as const;

export const Slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'kebab-case slug');

/** ISO 8601 UTC, e.g. 2026-10-08T06:30:00.000Z. Stored as TEXT. */
export const IsoTimestamp = z.string().datetime();
export type IsoTimestamp = z.infer<typeof IsoTimestamp>;

/** YYYY-MM-DD. */
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Vault-relative POSIX path, e.g. `roles/temporal_staff-pm.md`. Never absolute. */
export const VaultPath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/') && !p.includes('..'), 'vault-relative path');
export type VaultPath = z.infer<typeof VaultPath>;

export const Probability = z.number().min(0).max(1);

/** 1..5 criterion score. */
export const CriterionScore = z.number().int().min(1).max(5);
