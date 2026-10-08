import { PROFILE_COMPONENT_KEYS } from '@perfect-placement/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { rubricWeights, safeParseComponentData } from './components.js';
import { convertV1Profile, parseBullets, parseSections, renderConversionReport, verifyCoverage } from './convert-v1.js';
import { getComponents, insertVersion } from './store.js';
import { SYNTH_V1 } from './synthetic.js';
import { createTempDb } from './testing.js';

const NOW = new Date('2026-10-08T00:00:00Z');

describe('markdown helpers', () => {
  it('parse sections with heading paths', () => {
    const s = parseSections('# A\n\nx\n\n## B\n\ny\n\n### C\nz\n## D\n');
    expect(s.map((x) => x.path.join('>'))).toEqual(['A', 'A>B', 'A>B>C', 'A>D']);
  });
  it('split labeled bullets', () => {
    expect(parseBullets(['- **Comp:** floor ~$1K', '- plain', '  continued'])).toEqual([
      { label: 'Comp', text: 'floor ~$1K', raw: '- **Comp:** floor ~$1K' },
      { text: 'plain continued', raw: '- plain\n  continued' },
    ]);
  });
});

describe('v1 profile converter (synthetic v1-shaped inputs)', () => {
  const conv = convertV1Profile(SYNTH_V1, NOW);

  it('drops nothing: every source line and rubric.json leaf is in the output', () => {
    const cov = verifyCoverage(SYNTH_V1, conv);
    expect(cov.files.filter((f) => f.missing.length)).toEqual([]);
    expect(cov.ok).toBe(true);
    expect(cov.files).toHaveLength(7);
  });

  it('detects a dropped line', () => {
    const tampered = structuredClone(conv);
    tampered.components.craft.data_json.v1_sections = [];
    tampered.components.craft.data_json.notes = [];
    tampered.components.craft.data_json.target = '';
    expect(verifyCoverage(SYNTH_V1, tampered).ok).toBe(false);
  });

  it('produces 11 valid components', () => {
    for (const key of PROFILE_COMPONENT_KEYS) expect(safeParseComponentData(key, conv.components[key].data_json).success, key).toBe(true);
  });

  it('maps rubric.json weights, comp, dealbreakers and dream companies', () => {
    const comps = PROFILE_COMPONENT_KEYS.map((k) => conv.components[k]);
    expect(rubricWeights(comps)).toEqual({ c1: 14, c2: 10, c3: 12, c4: 14, c5: 10, c6: 12, c7: 8, c8: 10, c9: 10 });
    expect(conv.components.team.weight).toBe(0.22);
    expect(conv.components.terms.weight).toBeNull();
    expect(conv.components.terms.data_json).toMatchObject({
      comp_floor: 190000,
      comp_penalty_below: 170000,
      comp_target: 210000,
      comp_target_max: 230000,
      currency: 'USD',
    });
    expect(conv.components.work_mode.data_json.modes).toEqual(['remote']);
    expect(conv.components.work_mode.data_json.relocation).toBe('no');
    expect(conv.components.work_mode.data_json.home_location).toBe('Springfield, Example State');
    expect(conv.components.company.data_json.dream_companies).toEqual(['Examplesoft', 'Bytehaus']);
    expect(conv.components.company.data_json.affinity).toEqual({ examplesoft: 3, bytehaus: 3 });
    expect(conv.components.company.data_json.reference_companies).toEqual(['Examplesoft', 'Datacorp', 'Pipeworks']);
    expect(conv.behavior_changes.join(' ')).toMatch(/bypass/);
    expect(conv.config.scoring).toEqual({ green_min: 75, yellow_min: 55 });
    expect(conv.version_reason).toBe('v1 import (rubric v1, 2026-01-01)');
  });

  it('maps perfect_role into craft, domain, dealbreakers and open questions', () => {
    expect(conv.components.craft.data_json).toMatchObject({ functions: ['PM'], explore: ['FDE'], facing: 'external', level: 'principal' });
    expect(conv.components.domain.data_json.ranked).toEqual(['data infra', 'ML platforms', 'observability']);
    expect(conv.components.dealbreakers.data_json.hard_nos).toEqual(
      expect.arrayContaining(['Onsite roles that require relocation.', 'not remote']),
    );
    expect(conv.components.terms.data_json.open_questions).toEqual(['Comp floor and the no-brainer number.']);
    expect(conv.components.team.data_json.open_questions).toEqual(['Team archetype I thrive under.']);
    const anchors = conv.components.domain.data_json.criteria as Array<{ id: string; anchors?: Record<string, string> }>;
    expect(anchors.find((a) => a.id === 'c4')?.anchors).toEqual({ '1': 'Shallow data', '3': 'Solid data', '5': 'Data is the core' });
  });

  it('maps stories, positioning, defaults and resume into Story and Voice', () => {
    const story = conv.components.story.data_json;
    expect(story.headline).toBe('Principal Product Manager, Data Platforms');
    expect((story.stories as Array<Record<string, unknown>>)[0]).toMatchObject({
      title: 'Self-serve analytics',
      status: 'DRAFT',
      themes: ['0->1', 'scale'],
      result: '120 teams onboarded.',
    });
    expect(story.contact).toMatchObject({ email: 'jordan@example.com' });
    expect(story.gaps).toEqual(['Public writing.']);
    const voice = conv.components.voice.data_json;
    expect(voice.positioning).toBe('The product leader who turns raw data into products customers pay for.');
    expect((voice.standard_answers as Record<string, string>)['Require visa sponsorship']).toBe('No.');
    expect(voice.pitches).toEqual({ '10-second': 'I turn data platforms into products.' });
    expect(conv.components.story.markdown).toContain('# Story');
    expect(conv.components.voice.markdown).toContain('Imported from v1');
  });

  it('writes into a db as a version (what lane A will do)', () => {
    const env = createTempDb();
    try {
      const { version } = insertVersion(env.db, {
        now: NOW,
        parent_id: null,
        reason: conv.version_reason,
        event_id: null,
        drafts: Object.fromEntries(
          PROFILE_COMPONENT_KEYS.map((k) => [
            k,
            {
              key: k,
              confidence: conv.components[k].confidence,
              weight: conv.components[k].weight,
              data_json: conv.components[k].data_json,
              md_path: null,
            },
          ]),
        ),
      });
      expect(getComponents(env.db, version.id)).toHaveLength(11);
    } finally {
      env.cleanup();
    }
  });

  it('renders a report', () => {
    const md = renderConversionReport(conv, verifyCoverage(SYNTH_V1, conv));
    expect(md).toContain('**Nothing dropped.**');
    expect(md).toContain('01_Profile/perfect_role.md');
    expect(md).not.toContain('jordan@example.com');
  });
});

afterEach(() => {});
