import {
  CRITERIA,
  CRITERION_LABELS,
  type Criterion,
  cleanDictation,
  type OpOutput,
  PROFILE_COMPONENT_KEYS,
  PROFILE_COMPONENT_KIND,
  type ProfileComponentKey,
} from '@perfect-placement/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAct, useApp, useOp } from '../client/context';
import { Btn } from '../components/Btn';
import { PrimaryButton, SecondaryButton } from '../components/controls';
import { RoleTile } from '../components/glyphs';
import { ProgressDots } from '../components/meters';
import { KIND_HEX, MiniConstellation, type NodeData } from '../components/profile';
import { PPMark } from '../components/shell';
import { C, display, eyebrow, mono, tab, X } from '../components/theme';
import { humanize, k } from '../lib/format';
import { COMPONENT_NAME, chipsOf } from '../lib/profile';
import { activeLabel, isActive, runOutcome } from '../lib/runs';
import { go } from '../router';

type OnboardState = OpOutput<'onboard.answer'>;
const NODE_COUNT = PROFILE_COMPONENT_KEYS.length;

/** A file as base64 (the upload is kept in the vault and its text extracted by the engine, #38). */
async function toBase64(f: File): Promise<string> {
  const bytes = new Uint8Array(await f.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function Onboarding({ calibrate: startAtCalibrate }: { calibrate?: boolean } = {}) {
  const act = useAct();
  const { showToast, client, watchRun, runs, activeRun } = useApp();
  const [step, setStep] = useState(startAtCalibrate ? 2 : 0);
  const [state, setState] = useState<OnboardState | null>(null);
  const [file, setFile] = useState<string | null>(null);
  const [parsed, setParsed] = useState(0);
  const [qn, setQn] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string | number | string[]>>({});
  const [weights, setWeights] = useState<Record<Criterion, number> | null>(null);
  const [ci, setCi] = useState(0);
  /** List text questions (voice.sample): the item being typed before Add. */
  const [pending, setPending] = useState('');
  /** Dictated text answers shown cleaned for confirmation: the raw text by question id (#38). */
  const [rawOf, setRawOf] = useState<Record<string, string>>({});
  /** The headless onboard run parsing the resume (#38). */
  const [parseRunId, setParseRunId] = useState<string | null>(null);
  /** A scoped re-interview that reached confirm: the component to show on You after Start. */
  const [reinterview, setReinterview] = useState<ProfileComponentKey | null>(null);
  const samples = useOp('onboard.samples', step >= 2 ? {} : null);
  const profile = useOp('profile.get', step === 3 ? {} : null);
  const saved = useOp('onboard.state', {});
  const fileInput = useRef<HTMLInputElement>(null);

  // Resume mid-flow once, from the engine's onboarding session.
  const resumed = useRef(false);
  useEffect(() => {
    if (resumed.current || !saved.data) return;
    resumed.current = true;
    if (startAtCalibrate) return;
    const at = { resume: 0, interview: 1, calibrate: 2, confirm: 3, done: 0 }[saved.data.step];
    if (at === 1 && !saved.data.next_question) return;
    if (at > 0) {
      setState(saved.data);
      setStep(at);
    }
  }, [saved.data, startAtCalibrate]);

  // Parse animation: nodes light one by one after the drop.
  useEffect(() => {
    if (!file || parsed >= NODE_COUNT) return;
    const id = setTimeout(() => setParsed((n) => n + 1), 230);
    return () => clearTimeout(id);
  }, [file, parsed]);

  const ingest = async (f: File | null) => {
    if (state) return;
    setFile(f?.name ?? 'resume');
    const content_base64 = f ? await toBase64(f).catch(() => '') : '';
    const o = await act('onboard.ingest_resume', f && content_base64 ? { file: { name: f.name, content_base64 } } : {});
    if (o.status !== 'ok') {
      setFile(null);
      return;
    }
    setState(o.output);
    const runId = o.output.resume?.parse_run_id;
    if (!runId) return;
    setParseRunId(runId);
    // Follow the parse run; when it ends, the extracted facts replace the preview.
    const g = await client.run('runs.get', { run_id: runId });
    if (g.status === 'ok')
      watchRun(g.output.run, async () => {
        const s = await client.run('onboard.state', {});
        if (s.status === 'ok' && s.output.step !== 'done') setState(s.output);
      });
  };
  const parseRun = (parseRunId ? runs.find((r) => r.id === parseRunId) : undefined) ?? activeRun({ skill: 'onboard' });
  const parseLabel = parseRun ? (isActive(parseRun.status) ? activeLabel(parseRun) : runOutcome(parseRun)) : null;

  const q = state?.next_question ?? null;
  // A resume suggestion pre-fills an open question (#22); the user still confirms it with Next.
  const val = q ? (answers[q.id] ?? q.suggested) : undefined;
  const sliderMid = q ? Math.round(((q.min ?? 150) + (q.max ?? 300)) / 2) : 200;
  const qVal = q
    ? (val ??
      (q.answer_type === 'slider' ? sliderMid : q.answer_type === 'multi_chips' && q.options?.includes('Any') ? ['Any'] : undefined))
    : undefined;
  // A list question (voice.sample) keeps several items: Add appends, Remove drops one, Next sends the list.
  const listQ = !!q?.max_items;
  const items: string[] = listQ ? (Array.isArray(val) ? val : (q?.items ?? [])) : [];
  const listOut = listQ ? [...items, ...(pending.trim() && !items.includes(pending.trim()) ? [pending.trim()] : [])] : [];
  const answered = listQ
    ? listOut.length > 0 && listOut.length <= (q?.max_items ?? 0)
    : qVal !== undefined && !(Array.isArray(qVal) && qVal.length === 0) && !(typeof qVal === 'string' && !qVal.trim());
  const addItem = () => {
    if (!q || !pending.trim() || items.length >= (q.max_items ?? 0)) return;
    setAnswers({ ...answers, [q.id]: listOut });
    setPending('');
  };

  const calibrate = useCallback(
    async (choice: 'yes' | 'no' | 'maybe') => {
      const s = samples.data?.items[ci];
      if (!s) return;
      const o = await act('onboard.calibrate', { sample_id: s.id, choice });
      if (o.status === 'ok') {
        setWeights(o.output.weights as Record<Criterion, number>);
        setCi((i) => i + 1);
      }
    },
    [samples.data, ci, act],
  );

  useEffect(() => {
    if (step !== 2) return;
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      const c = k === 'y' ? 'yes' : k === 'n' ? 'no' : k === 'm' ? 'maybe' : null;
      if (c && !(e.target instanceof Element && e.target.closest('input, [role="dialog"]'))) void calibrate(c);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, calibrate]);

  const next = async () => {
    if (step === 0) {
      if (state && parsed >= NODE_COUNT) setStep(1);
      return;
    }
    if (step === 1 && q && answered && (listQ || qVal !== undefined)) {
      // A dictated answer is shown cleaned first; Next again confirms it (the raw text is kept).
      if (q.answer_type === 'text' && !listQ && typeof qVal === 'string' && rawOf[q.id] === undefined) {
        const clean = cleanDictation(qVal);
        if (clean && clean !== qVal.trim()) {
          setRawOf({ ...rawOf, [q.id]: qVal });
          setAnswers({ ...answers, [q.id]: clean });
          return;
        }
      }
      const raw = rawOf[q.id];
      const o = await act('onboard.answer', {
        question_id: q.id,
        value: listQ ? listOut : (qVal as string | number | string[]),
        ...(raw !== undefined && !listQ ? { raw } : {}),
      });
      if (o.status !== 'ok') return;
      setPending('');
      setState(o.output);
      if (o.output.step === 'calibrate') setStep(2);
      else if (o.output.step === 'confirm') {
        // Only a scoped re-interview goes straight from the interview to confirm.
        setReinterview(q.component);
        setStep(3);
      } else setQn((n) => n + 1);
      return;
    }
    setStep((s) => Math.min(3, s + 1));
  };

  /** "I don't know" (#23): the question is answered with nothing. */
  const skip = async () => {
    if (!q) return;
    const o = await act('onboard.answer', { question_id: q.id, skip: true });
    if (o.status !== 'ok') return;
    setPending('');
    setState(o.output);
    if (o.output.step === 'calibrate') setStep(2);
    else if (o.output.step === 'confirm') {
      setReinterview(q.component);
      setStep(3);
    } else setQn((n) => n + 1);
  };
  /** What the resume gave each component (#22), shown before and during the interview. */
  const pulled = state?.resume_drafts ?? [];
  const pulledOf = (key: ProfileComponentKey) => pulled.find((d) => d.component === key);

  const lit = (key: string) => {
    if (step > 0) return true;
    const filled = state?.components_filled ?? [];
    const idx = filled.indexOf(key as never);
    return idx >= 0 && idx < parsed;
  };
  const conf = (key: string) => Math.round((profile.data?.components.find((c) => c.key === key)?.confidence ?? 0.7) * 100);
  const nodes: NodeData[] = PROFILE_COMPONENT_KEYS.map((key) => ({
    key,
    name: COMPONENT_NAME[key],
    kind: PROFILE_COMPONENT_KIND[key],
    conf: conf(key),
    pending: false,
  }));

  const base = samples.data?.weights;
  const w = weights ?? base;
  const total = samples.data?.items.length ?? 12;
  const card = samples.data?.items[Math.min(ci, total - 1)];
  const calDone = !!samples.data && ci >= total;

  const primary =
    step === 3 ? (
      <PrimaryButton
        label="Start"
        op="onboard.confirm"
        onClick={async () => {
          const o = await act('onboard.confirm', {});
          if (o.status === 'ok') {
            showToast('Profile live');
            go(reinterview ? { screen: 'you', component: reinterview } : { screen: 'now' });
          }
        }}
      />
    ) : (
      <PrimaryButton
        label="Next"
        op={step === 1 ? 'onboard.answer' : null}
        dim={(step === 0 && (!state || parsed < NODE_COUNT)) || (step === 1 && !answered)}
        disabled={(step === 0 && !state) || (step === 1 && !answered)}
        onClick={() => void next()}
      />
    );

  const comp = (key: string) => profile.data?.components.find((c) => c.key === key)?.data_json ?? {};
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => humanize(String(x))).join(' · ') : '');
  const floor = comp('terms').comp_floor;
  const filters = [
    list(comp('work_mode').modes),
    typeof floor === 'number' ? `Base ≥ $${k(floor)}` : '',
    list(comp('company').stages),
  ].filter(Boolean);
  const deal = profile.data?.components.find((c) => c.key === 'dealbreakers');
  const story = profile.data?.components.find((c) => c.key === 'story');

  return (
    <div data-screen-label="Onboarding" style={{ maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', minHeight: 72 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 22 }}>
          <PPMark />
          <ProgressDots count={4} index={step} resolved={[0, 1, 2, 3].map((i) => i < step)} gap={8} active={C.emerald} />
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <SecondaryButton
            label="Exit"
            op={null}
            height={44}
            onClick={() => go({ screen: 'now' })}
            style={{ color: C.muted, padding: '0 18px' }}
            hover={{ borderColor: C['emerald-2'], color: C.fg }}
          />
          {primary}
        </div>
      </div>

      {step === 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.15fr) 420px', gap: 56, marginTop: 48, alignItems: 'center' }}>
          <Btn
            op="onboard.ingest_resume"
            className="dropzone"
            onClick={() => fileInput.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void ingest(e.dataTransfer.files[0] ?? null);
            }}
            style={{
              height: 460,
              border: `2px dashed ${file ? C['emerald-2'] : C['line-2']}`,
              borderRadius: 16,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 22,
              background: file ? X.deep18 : 'transparent',
              transition: 'all .2s',
              color: C.fg,
              width: '100%',
            }}
            hover={{ borderColor: C['emerald-2'] }}
          >
            <svg
              aria-hidden="true"
              width="64"
              height="64"
              viewBox="0 0 64 64"
              fill="none"
              stroke={C.emerald}
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="32" cy="32" r="29" stroke={C['line-2']} />
              <path d="M32 18v24M22 33l10 10 10-10" />
            </svg>
            <span style={display(40, 800, '-0.03em')}>Resume</span>
            {file ? (
              <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
                <span style={{ ...mono(12, C.emerald), border: `1px solid ${C['emerald-2']}`, borderRadius: 999, padding: '6px 14px' }}>
                  {file}
                </span>
                {parseLabel && (
                  <span className="dropzone__run" style={{ ...mono(11, C.muted), letterSpacing: '.1em' }}>
                    {parseLabel}
                  </span>
                )}
                <span style={{ width: 220, height: 4, borderRadius: 4, background: C.line, overflow: 'hidden', display: 'block' }}>
                  <span
                    style={{
                      display: 'block',
                      height: '100%',
                      width: `${(parsed / NODE_COUNT) * 100}%`,
                      background: C.emerald,
                      transition: 'width .2s',
                    }}
                  />
                </span>
              </span>
            ) : (
              <span style={{ ...mono(11, C.dim), letterSpacing: '.1em' }}>PDF · DOCX · MD</span>
            )}
          </Btn>
          <input
            ref={fileInput}
            type="file"
            hidden
            accept=".pdf,.md,.txt,.docx"
            onChange={(e) => void ingest(e.target.files?.[0] ?? null)}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
            <MiniConstellation nodes={nodes} lit={lit} />
            {state && parsed >= NODE_COUNT && pulled.length > 0 && (
              <div className="resume-drafts" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div style={eyebrow()}>From resume</div>
                {pulled.map((d) => (
                  <ResumeDraft key={d.component} name={COMPONENT_NAME[d.component]} conf={d.confidence} items={d.items} />
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {step === 1 && q && (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 240px', gap: 48, marginTop: 90, alignItems: 'start' }}>
          <div>
            <div className="onboard-q__for" style={eyebrow()}>
              Q {qn + 1} · {COMPONENT_NAME[q.component]}
            </div>
            <div
              className="onboard-q__text"
              style={{ ...display(44, 800, '-0.03em'), lineHeight: 1.08, margin: `14px 0 ${q.example ? 14 : 40}px`, maxWidth: 860 }}
            >
              {q.label}
            </div>
            {q.example && (
              <div className="onboard-q__example" style={{ fontSize: 16, color: C.muted, marginBottom: 36 }}>
                {q.example}
              </div>
            )}
            {(q.answer_type === 'chips' || q.answer_type === 'multi_chips') && (
              <div className="onboard-q" style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                {q.options?.map((o) => {
                  const cur = qVal;
                  const on = Array.isArray(cur) ? cur.includes(o) : cur === o;
                  const pick = () => {
                    if (q.answer_type === 'chips') return setAnswers({ ...answers, [q.id]: o });
                    const arr = Array.isArray(cur) ? cur : [];
                    let a = arr.includes(o) ? arr.filter((x) => x !== o) : [...arr.filter((x) => x !== 'Any'), o];
                    if (o === 'Any') a = ['Any'];
                    setAnswers({ ...answers, [q.id]: a.length || !q.options?.includes('Any') ? a : ['Any'] });
                  };
                  return (
                    <Btn
                      key={o}
                      op="local"
                      className="chip"
                      aria-pressed={on}
                      onClick={pick}
                      style={{
                        height: 56,
                        padding: '0 26px',
                        borderRadius: 999,
                        border: `1.5px solid ${on ? C.emerald : C['line-2']}`,
                        background: on ? C['emerald-deep'] : 'transparent',
                        color: C.fg,
                        fontSize: 18,
                        fontWeight: 500,
                      }}
                      hover={{ borderColor: C['emerald-2'] }}
                    >
                      {q.kind === 'confirm' ? (CONFIRM_LABEL[o] ?? o) : o}
                    </Btn>
                  );
                })}
              </div>
            )}
            {q.answer_type === 'slider' && (
              <div className="onboard-q" style={{ maxWidth: 620 }}>
                <div style={{ ...display(64, 800, '-0.04em'), color: C.emerald, ...tab }}>${String(qVal)}K</div>
                <input
                  type="range"
                  aria-label={q.label}
                  min={q.min ?? 150}
                  max={q.max ?? 300}
                  step={q.step ?? 5}
                  value={typeof qVal === 'number' ? qVal : sliderMid}
                  onChange={(e) => setAnswers({ ...answers, [q.id]: Number(e.target.value) })}
                  style={{ width: '100%', marginTop: 18 }}
                />
                <div style={{ display: 'flex', justifyContent: 'space-between', ...mono(11, C.dim), marginTop: 6 }}>
                  <span>${q.min ?? 150}K</span>
                  <span>${q.max ?? 300}K</span>
                </div>
              </div>
            )}
            {q.answer_type === 'text' && listQ && (
              <div className="onboard-q" style={{ maxWidth: 620, display: 'flex', flexDirection: 'column', gap: 12 }}>
                {items.map((it, i) => (
                  <div
                    key={it}
                    className="onboard-q__item"
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 14,
                      border: `1.5px solid ${C['line-2']}`,
                      borderRadius: 12,
                      padding: '12px 16px',
                    }}
                  >
                    <span style={{ ...mono(11, C.dim), letterSpacing: '.1em', paddingTop: 3 }}>{i + 1}</span>
                    <span style={{ flex: 1, fontSize: 15, color: C.fg, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{it}</span>
                    <Btn
                      op="local"
                      aria-label={`Remove ${i + 1}`}
                      onClick={() => setAnswers({ ...answers, [q.id]: items.filter((_, j) => j !== i) })}
                      style={{ background: 'transparent', border: 'none', color: C.muted, fontSize: 13, padding: 0 }}
                      hover={{ color: C.fg }}
                    >
                      Remove
                    </Btn>
                  </div>
                ))}
                {items.length < (q.max_items ?? 0) && (
                  <>
                    <textarea
                      aria-label={q.label}
                      value={pending}
                      maxLength={q.max_chars}
                      onChange={(e) => setPending(e.target.value)}
                      rows={4}
                      style={{
                        width: '100%',
                        boxSizing: 'border-box',
                        background: 'transparent',
                        border: `1.5px solid ${C['line-2']}`,
                        borderRadius: 12,
                        color: C.fg,
                        fontSize: 18,
                        padding: '16px 20px',
                        fontFamily: 'inherit',
                        resize: 'vertical',
                      }}
                    />
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ ...mono(11, C.dim), letterSpacing: '.1em' }}>
                        {items.length} / {q.max_items}
                      </span>
                      <Btn
                        op="local"
                        disabled={!pending.trim()}
                        onClick={addItem}
                        style={{
                          height: 40,
                          padding: '0 20px',
                          borderRadius: 999,
                          border: `1.5px solid ${C['line-2']}`,
                          background: 'transparent',
                          color: C.fg,
                          fontSize: 15,
                          fontWeight: 500,
                        }}
                        hover={{ borderColor: C['emerald-2'] }}
                      >
                        Add
                      </Btn>
                    </div>
                  </>
                )}
              </div>
            )}
            {q.answer_type === 'text' && !listQ && (
              <div className="onboard-q" style={{ maxWidth: 620 }}>
                {rawOf[q.id] !== undefined && <div style={{ ...eyebrow(C.emerald), marginBottom: 10 }}>Cleaned</div>}
                <textarea
                  aria-label={q.label}
                  value={typeof qVal === 'string' ? qVal : ''}
                  onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
                  rows={4}
                  style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    background: 'transparent',
                    border: `1.5px solid ${C['line-2']}`,
                    borderRadius: 12,
                    color: C.fg,
                    fontSize: 18,
                    padding: '16px 20px',
                    fontFamily: 'inherit',
                    resize: 'vertical',
                  }}
                />
              </div>
            )}
            <Btn
              op="onboard.answer"
              className="onboard-q__skip"
              onClick={() => void skip()}
              style={{ marginTop: 28, background: 'transparent', border: 'none', color: C.muted, fontSize: 15, padding: 0 }}
              hover={{ color: C.fg }}
            >
              I don't know
            </Btn>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <QuestionNode
              name={COMPONENT_NAME[q.component]}
              color={KIND_HEX[PROFILE_COMPONENT_KIND[q.component]]}
              conf={
                q.answer_type === 'slider'
                  ? Math.round(60 + ((typeof qVal === 'number' ? qVal : sliderMid) - (q.min ?? 150)) / 5)
                  : Array.isArray(qVal)
                    ? qVal.includes('Any')
                      ? 55
                      : 72
                    : qVal
                      ? 95
                      : 0
              }
            />
            {pulledOf(q.component) && (
              <ResumeDraft name="From resume" conf={pulledOf(q.component)?.confidence ?? 0} items={pulledOf(q.component)?.items ?? []} />
            )}
          </div>
        </div>
      )}

      {step === 2 && (
        <div
          className="calibrate"
          style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 420px', gap: 56, marginTop: 44, alignItems: 'start' }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 26 }}>
            <div style={{ ...mono(12, C.muted), letterSpacing: '.1em' }}>{samples.data ? `${Math.min(ci + 1, total)} / ${total}` : ''}</div>
            {card && !calDone && (
              <>
                <div
                  className="calibrate__card"
                  style={{
                    width: 460,
                    maxWidth: '100%',
                    background: C.panel,
                    border: `1px solid ${C['line-2']}`,
                    borderRadius: 12,
                    padding: 28,
                    boxShadow: `8px 8px 0 -2px ${X.calShadow1}, 16px 16px 0 -4px ${C['bg-2']}`,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                    <RoleTile letter={card.letter} fresh="ok" size={52} />
                    <div>
                      <div style={{ fontSize: 18, fontWeight: 600 }}>{card.title}</div>
                      <div style={{ fontSize: 14, color: C.muted, marginTop: 3 }}>{card.company}</div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
                    <span style={{ background: C['panel-2'], borderRadius: 999, padding: '6px 12px', fontSize: 13 }}>{card.comp}</span>
                    <span style={{ background: C['panel-2'], borderRadius: 999, padding: '6px 12px', fontSize: 13 }}>{card.mode}</span>
                  </div>
                  <div
                    style={{ display: 'grid', gridTemplateColumns: 'repeat(9,1fr)', gap: 6, height: 64, alignItems: 'end', marginTop: 26 }}
                  >
                    {CRITERIA.map((c) => {
                      const v = card.criteria[c];
                      return (
                        <div
                          key={c}
                          style={{
                            height: `${v * 20}%`,
                            background: v >= 4 ? C.emerald : v >= 3 ? C['emerald-2'] : C['line-2'],
                            borderRadius: 4,
                          }}
                        />
                      );
                    })}
                  </div>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(9,1fr)',
                      gap: 6,
                      marginTop: 6,
                      ...mono(9, C.dim),
                      textAlign: 'center',
                    }}
                  >
                    {CRITERIA.map((c, i) => (
                      <span key={c}>C{i + 1}</span>
                    ))}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 18 }}>
                  {(
                    [
                      ['no', 'N', C.coral, X.coral12],
                      ['maybe', 'M', C.gold, X.gold12],
                      ['yes', 'Y', C.emerald, X.em12],
                    ] as const
                  ).map(([choice, k, col, hov]) => (
                    <Btn
                      key={k}
                      op="onboard.calibrate"
                      aria-label={k}
                      onClick={() => void calibrate(choice)}
                      style={{
                        width: 72,
                        height: 72,
                        borderRadius: '50%',
                        border: `2px solid ${col}`,
                        background: 'transparent',
                        color: col,
                        ...mono(20),
                        fontWeight: 700,
                      }}
                      hover={{ background: hov }}
                    >
                      {k}
                    </Btn>
                  ))}
                </div>
              </>
            )}
            {calDone && (
              <div
                className="cal-done"
                style={{
                  width: 220,
                  height: 220,
                  borderRadius: '50%',
                  border: `12px solid ${C.emerald}`,
                  display: 'grid',
                  placeItems: 'center',
                  ...display(48),
                  marginTop: 30,
                }}
              >
                {total}
              </div>
            )}
          </div>
          <div>
            <div style={{ ...eyebrow(), marginBottom: 18 }}>Weights</div>
            <div className="weights" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {w &&
                base &&
                CRITERIA.map((c, j) => {
                  const x = w[c];
                  const d = x - base[c];
                  const flat = Math.abs(d) < 0.6;
                  return (
                    <div
                      key={c}
                      className="weights__row"
                      style={{ display: 'grid', gridTemplateColumns: '28px 86px minmax(0,1fr) 30px 12px', gap: 10, alignItems: 'center' }}
                    >
                      <span style={mono(11, C.dim)}>C{j + 1}</span>
                      <span style={{ fontSize: 13, color: C.muted }}>{CRITERION_LABELS[c]}</span>
                      <div style={{ height: 8, borderRadius: 4, background: C.line, overflow: 'hidden' }}>
                        <div
                          className="weights__bar"
                          style={{
                            height: '100%',
                            width: `${Math.min(100, (x / 22) * 100)}%`,
                            background: flat ? C['emerald-2'] : d > 0 ? C.emerald : C.gold,
                            borderRadius: 4,
                            transition: 'width .45s ease',
                          }}
                        />
                      </div>
                      <span style={{ ...mono(13), textAlign: 'right', ...tab }}>{Math.round(x)}</span>
                      <span style={{ fontSize: 9, color: d > 0 ? C.emerald : C.gold }}>{flat ? '' : d > 0 ? '▲' : '▼'}</span>
                    </div>
                  );
                })}
            </div>
          </div>
        </div>
      )}

      {step === 3 && (
        <div
          style={{
            maxWidth: 1000,
            margin: '48px auto 0',
            background: C.panel,
            border: `1px solid ${C['line-2']}`,
            borderRadius: 12,
            padding: 36,
            display: 'grid',
            gridTemplateColumns: '400px minmax(0,1fr)',
            gap: 40,
            alignItems: 'center',
          }}
        >
          <MiniConstellation nodes={nodes} lit={() => true} />
          <div>
            <div style={display(40, 800, '-0.03em')}>You</div>
            <div style={{ fontSize: 15, color: C.muted, marginTop: 4 }}>
              {String((story?.data_json as { headline?: string } | undefined)?.headline ?? '')}
            </div>
            <div style={{ ...eyebrow(C.gold), margin: '28px 0 10px' }}>Filters</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {filters.map((x) => (
                <span key={x} style={{ border: `1px solid ${X.gold50}`, borderRadius: 999, padding: '6px 12px', fontSize: 13 }}>
                  {x}
                </span>
              ))}
            </div>
            <div style={{ ...eyebrow(C.emerald), margin: '24px 0 12px' }}>Top weights</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {w &&
                CRITERIA.map((c, j) => ({ c, j, v: Math.round(w[c]) }))
                  .sort((a, b) => b.v - a.v)
                  .slice(0, 4)
                  .map(({ c, j, v }) => (
                    <div
                      key={c}
                      style={{ display: 'grid', gridTemplateColumns: '28px 90px minmax(0,1fr) 28px', gap: 10, alignItems: 'center' }}
                    >
                      <span style={mono(11, C.dim)}>C{j + 1}</span>
                      <span style={{ fontSize: 13 }}>{CRITERION_LABELS[c]}</span>
                      <div style={{ height: 6, borderRadius: 4, background: C.line }}>
                        <div style={{ height: '100%', width: `${(v / 22) * 100}%`, background: C.emerald, borderRadius: 4 }} />
                      </div>
                      <span style={{ ...mono(12), textAlign: 'right' }}>{v}</span>
                    </div>
                  ))}
            </div>
            <div style={{ ...eyebrow(C.coral), margin: '24px 0 10px' }}>Dealbreakers</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {chipsOf(deal?.data_json ?? {}).map((x) => (
                <span
                  key={x.label}
                  style={{ border: '1px solid rgba(239,125,125,0.45)', borderRadius: 999, padding: '6px 12px', fontSize: 13 }}
                >
                  {x.value ? `${x.label} ${x.value}` : x.label}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const CONFIRM_LABEL: Record<string, string> = { yes: 'Yes', edit: 'Edit' };

/** One component's resume draft: name, confidence, the lines pulled (#22). */
function ResumeDraft({ name, conf, items }: { name: string; conf: number; items: string[] }) {
  return (
    <div
      className="resume-draft"
      style={{ background: C.panel, border: `1px solid ${C['line-2']}`, borderRadius: 12, padding: '14px 16px' }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>{name}</span>
        <span className="resume-draft__conf" style={{ ...mono(11, conf >= 0.7 ? C.emerald : C.gold), ...tab }}>
          {Math.round(conf * 100)}%
        </span>
      </div>
      {items.slice(0, 3).map((x) => (
        <div key={x} style={{ fontSize: 13, color: C.muted, marginTop: 6, overflowWrap: 'anywhere' }}>
          {x}
        </div>
      ))}
    </div>
  );
}

function QuestionNode({ name, color, conf }: { name: string; color: string; conf: number }) {
  const Cu = 2 * Math.PI * 42;
  return (
    <div
      style={{
        background: C.panel,
        border: `1px solid ${C['line-2']}`,
        borderRadius: 12,
        padding: 22,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <div style={{ position: 'relative', width: 96, height: 96 }}>
        <svg aria-hidden="true" viewBox="0 0 96 96" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }}>
          <circle cx="48" cy="48" r="42" fill="none" stroke={C.line} strokeWidth="5" />
          <circle
            cx="48"
            cy="48"
            r="42"
            fill="none"
            stroke={color}
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={`${(Cu * conf) / 100} ${Cu}`}
            transform="rotate(-90 48 48)"
            style={{ transition: 'stroke-dasharray .4s' }}
          />
        </svg>
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', ...mono(16) }}>{conf}</div>
      </div>
      <div style={{ fontSize: 15, fontWeight: 600 }}>{name}</div>
    </div>
  );
}
