import { CONTACT_ROLES, ContactLink, ContactRole, peopleClassify, peopleLink } from '@perfect-placement/contracts';
import {
  getCompany,
  getContact,
  getLinkForCompany,
  getLinkForRole,
  getRole,
  insertLink,
  newId,
  readVault,
  stripFrontmatter,
  updateLink,
} from './repo.js';
import { isHiringTeam, tierFor } from './tier.js';
import { err, type Handler } from './types.js';

const JD_EXCERPT_MAX = 1500;

export const CLASSIFY_INSTRUCTIONS =
  'Who is this person for the role? hiring_manager = the person this role reports to; hiring_team = interviews or works directly with the hire; recruiter = talent or recruiting; peer = same company, not involved in the hire; unrelated = not at the company or no connection to the role.';

/**
 * people.classify: one resolver Choice question (decision kind `people.classify`, low impact).
 * The resolver writes the decision row and returns the policy outcome. When the outcome is
 * `human`, the link keeps its provisional tier and the pick waits in Needs you; otherwise the
 * link's tier and is_hiring_team are updated (tier = degree x hiring team, mechanics).
 */
export const classifyContact: Handler<'people.classify'> = async (raw, ctx, deps) => {
  const parsed = peopleClassify.input.safeParse(raw);
  if (!parsed.success) return err('invalid_input', 'people.classify input', parsed.error.issues);
  const { contact_id, role_id } = parsed.data;
  const { db } = deps;

  const contact = getContact(db, contact_id);
  if (!contact) return err('not_found', `contact ${contact_id}`);
  const role = getRole(db, role_id);
  if (!role) return err('not_found', `role ${role_id}`);
  const company = getCompany(db, role.company_id);
  const link = getLinkForRole(db, contact_id, role_id);
  if (!link) return err('not_found', `no contact_link for ${contact_id} on ${role_id}; run people.find or people.link first`);

  const jd = role.md_path ? readVault(deps.vaultDir, role.md_path) : null;
  const state: Record<string, string> = {
    contact_name: contact.name,
    contact_headline: contact.headline ?? '',
    role_title: role.title,
    company: company?.name ?? role.company_id,
    relationship: link.degree === '1' ? '1st degree' : link.degree === '2' ? '2nd degree' : 'no connection',
    jd_excerpt: jd ? stripFrontmatter(jd).slice(0, JD_EXCERPT_MAX) : '',
  };

  let result: Awaited<ReturnType<typeof deps.ask>>;
  try {
    result = await deps.ask({
      decision: 'people.classify',
      impact: 'low',
      state,
      questions: [{ id: 'who', type: 'choice', instructions: CLASSIFY_INSTRUCTIONS, options: [...CONTACT_ROLES] }],
      subject: { type: 'contact', id: contact_id },
    });
  } catch (e) {
    return err('backend_unavailable', `resolver: ${(e as Error).message}`);
  }
  const answer = result.answers[0];
  const decisionId = result.decisionIds[0];
  const outcome = result.outcomes[0];
  if (!answer || !decisionId || !outcome) return err('internal', 'resolver returned no answer');

  const who = ContactRole.safeParse(answer.value);
  const contactRole = who.success ? who.data : 'other';
  const hiring = isHiringTeam(contactRole);
  const tier = tierFor(link.degree, hiring);

  if (outcome !== 'human' && !ctx.dryRun) {
    updateLink(db, { ...link, tier, is_hiring_team: hiring });
  }

  return { status: 'ok', output: { role: contactRole, tier, p: answer.p, decision_id: decisionId }, eventIds: [] };
};

/**
 * people.link: link a contact to a role or company. Tier is mechanics: it must equal
 * degree x is_hiring_team. Upserts on (contact, role) or (contact, company) for company-only links.
 */
export const linkContact: Handler<'people.link'> = async (raw, ctx, deps) => {
  const parsed = peopleLink.input.safeParse(raw);
  if (!parsed.success) return err('invalid_input', 'people.link input', parsed.error.issues);
  const input = parsed.data;
  const { db } = deps;

  if (!getContact(db, input.contact_id)) return err('not_found', `contact ${input.contact_id}`);
  if (input.via_contact_id && !getContact(db, input.via_contact_id)) return err('not_found', `contact ${input.via_contact_id}`);
  if (!input.role_id && !input.company_id) return err('invalid_input', 'role_id or company_id is required');
  let companyId = input.company_id;
  if (input.role_id) {
    const role = getRole(db, input.role_id);
    if (!role) return err('not_found', `role ${input.role_id}`);
    if (companyId && companyId !== role.company_id)
      return err('invalid_input', `company_id ${companyId} does not match role company ${role.company_id}`);
    companyId = role.company_id;
  } else if (companyId && !getCompany(db, companyId)) {
    return err('not_found', `company ${companyId}`);
  }
  const expected = tierFor(input.degree, input.is_hiring_team);
  if (input.tier !== expected)
    return err(
      'invalid_input',
      `tier ${input.tier} does not match degree ${input.degree} and hiring team ${input.is_hiring_team} (expected ${expected})`,
    );
  if (input.via_contact_id && input.degree !== '2') return err('invalid_input', 'via_contact_id only applies to degree 2');

  const existing = input.role_id
    ? getLinkForRole(db, input.contact_id, input.role_id)
    : getLinkForCompany(db, input.contact_id, companyId as string);
  const link = ContactLink.parse({ ...input, company_id: companyId ?? null, id: existing?.id ?? newId(deps, 'cl') });
  if (!ctx.dryRun) {
    if (existing) updateLink(db, link);
    else insertLink(db, link);
  }
  return { status: 'ok', output: { link }, eventIds: [] };
};
