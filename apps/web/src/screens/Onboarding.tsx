import { CRITERIA, CRITERION_LABELS, type Criterion, type OpOutput, PROFILE_COMPONENT_KEYS } from '@perfect-placement/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAct, useOp } from '../client/context';
import { Chip, PrimaryButton, SecondaryButton } from '../components/controls';
import { Icon } from '../components/glyphs';
import { ProgressDots, ScoreRadar } from '../components/meters';
import { Constellation, ProfileNode } from '../components/profile';
import { ScreenHeader } from '../components/shell';
import { chipsOf } from '../lib/profile';
import { go } from '../router';

type OnboardState = OpOutput<'onboard.answer'>;
const STEP_TITLE = ['Resume', 'Interview', 'Calibrate', 'Confirm'] as const;

export function Onboarding() {
  const act = useAct();
  const [step, setStep] = useState(0);
  const [state, setState] = useState<OnboardState | null>(null);
  const [answer, setAnswer] = useState<string | number | string[] | null>(null);
  const [weights, setWeights] = useState<Record<Criterion, number> | null>(null);
  const [calIndex, setCalIndex] = useState(0);
  const samples = useOp('onboard.samples', step === 2 ? {} : null);
  const profile = useOp('profile.get', step === 3 ? {} : null);
  const fileInput = useRef<HTMLInputElement>(null);

  const ingest = async (file: File | null) => {
    const text = file ? await file.text().catch(() => '') : '';
    const o = await act('onboard.ingest_resume', text ? { text } : {});
    if (o.status === 'ok') setState(o.output);
  };

  const q = state?.next_question ?? null;
  useEffect(() => {
    setAnswer(q?.answer_type === 'slider' ? Math.round(((q.min ?? 0) + (q.max ?? 100)) / 2) : q?.answer_type === 'multi_chips' ? [] : null);
  }, [q]);

  const calibrate = useCallback(
    async (choice: 'yes' | 'no' | 'maybe') => {
      const s = samples.data?.items[calIndex];
      if (!s) return;
      const o = await act('onboard.calibrate', { sample_id: s.id, choice });
      if (o.status === 'ok') {
        setWeights(o.output.weights as Record<Criterion, number>);
        setCalIndex((i) => i + 1);
      }
    },
    [samples.data, calIndex, act],
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
    if (step === 1 && q && answer !== null) {
      const o = await act('onboard.answer', { question_id: q.id, value: answer });
      if (o.status !== 'ok') return;
      setState(o.output);
      if (o.output.step === 'calibrate') setStep(2);
      return;
    }
    setStep((s) => Math.min(3, s + 1));
  };

  const lit = state?.components_filled ?? [];
  const primary =
    step === 3 ? (
      <PrimaryButton
        label="Start"
        op="onboard.confirm"
        onClick={async () => {
          const o = await act('onboard.confirm', {});
          if (o.status === 'ok') go({ screen: 'now' });
        }}
      />
    ) : (
      <PrimaryButton
        label="Next"
        op={step === 1 ? 'onboard.answer' : null}
        disabled={(step === 0 && !state) || (step === 1 && (answer === null || (Array.isArray(answer) && !answer.length)))}
        onClick={() => void next()}
      />
    );

  const sample = samples.data?.items[calIndex];
  const total = samples.data?.items.length ?? 12;
  const w = weights ?? null;
  const maxW = w ? Math.max(...CRITERIA.map((c) => w[c])) : 1;

  return (
    <div className="screen screen--onboard">
      <ScreenHeader title={STEP_TITLE[step]} primary={primary}>
        <ProgressDots count={4} index={step} resolved={[0, 1, 2, 3].map((i) => i < step)} />
      </ScreenHeader>

      {step === 0 && (
        <div className="onboard-split">
          <button
            type="button"
            className={`dropzone ${state ? 'is-done' : ''}`}
            data-op="onboard.ingest_resume"
            onClick={() => fileInput.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              void ingest(e.dataTransfer.files[0] ?? null);
            }}
          >
            <Icon name={state ? 'check' : 'drop'} size={40} />
            <span className="panel-title">{state ? 'Parsed' : 'Drop resume'}</span>
          </button>
          <input
            ref={fileInput}
            type="file"
            hidden
            accept=".pdf,.md,.txt,.docx"
            onChange={(e) => void ingest(e.target.files?.[0] ?? null)}
          />
          <Constellation
            components={PROFILE_COMPONENT_KEYS.map((key) => ({ key, confidence: lit.includes(key) ? 0.6 : 0 }))}
            lit={lit}
            size={420}
          />
        </div>
      )}

      {step === 1 && q && (
        <div className="onboard-q">
          <span className="onboard-q__corner">
            <ProfileNode componentKey={q.component} confidence={0.5} size={56} />
          </span>
          <h2 className="onboard-q__text">{q.label}</h2>
          {(q.answer_type === 'chips' || q.answer_type === 'multi_chips') && (
            <div className="chip-row chip-row--lg">
              {q.options?.map((opt) => {
                const on = Array.isArray(answer) ? answer.includes(opt) : answer === opt;
                return (
                  <Chip
                    key={opt}
                    variant="filter"
                    label={opt}
                    on={on}
                    onClick={() =>
                      setAnswer(
                        q.answer_type === 'multi_chips'
                          ? on
                            ? (answer as string[]).filter((x) => x !== opt)
                            : [...((answer as string[]) ?? []), opt]
                          : opt,
                      )
                    }
                  />
                );
              })}
            </div>
          )}
          {q.answer_type === 'slider' && (
            <label className="slider slider--lg">
              <input
                type="range"
                aria-label={q.label}
                min={q.min}
                max={q.max}
                value={typeof answer === 'number' ? answer : (q.min ?? 0)}
                onChange={(e) => setAnswer(Number(e.target.value))}
              />
              <span className="card-number">{typeof answer === 'number' ? answer : ''}k</span>
            </label>
          )}
          {q.answer_type === 'text' && (
            <input className="text-input" aria-label={q.label} value={String(answer ?? '')} onChange={(e) => setAnswer(e.target.value)} />
          )}
        </div>
      )}

      {step === 2 && (
        <div className="calibrate">
          <div className="calibrate__card">
            {sample ? (
              <>
                <span className="eyebrow">
                  {calIndex + 1} / {total}
                </span>
                <span className="eyebrow">{sample.company}</span>
                <span className="panel-title">{sample.title}</span>
                <ScoreRadar criteria={CRITERIA.map((c) => sample.criteria[c])} size={220} />
                <div className="calibrate__keys">
                  <SecondaryButton label="No" op="onboard.calibrate" kbd="N" onClick={() => void calibrate('no')} />
                  <SecondaryButton label="Maybe" op="onboard.calibrate" kbd="M" onClick={() => void calibrate('maybe')} />
                  <SecondaryButton label="Yes" op="onboard.calibrate" kbd="Y" onClick={() => void calibrate('yes')} />
                </div>
              </>
            ) : samples.data ? (
              <span className="panel-title">Done</span>
            ) : null}
          </div>
          <div className="weights">
            {CRITERIA.map((c) => (
              <div key={c} className="weights__row">
                <span className="eyebrow">{CRITERION_LABELS[c]}</span>
                <span className="weights__bar">
                  <span style={{ width: `${w ? (w[c] / maxW) * 100 : 50}%` }} />
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="onboard-split">
          <Constellation components={(profile.data?.components ?? []).map((c) => ({ key: c.key, confidence: c.confidence }))} size={460} />
          <div className="confirm-filters">
            {(profile.data?.components ?? [])
              .filter((c) => c.kind === 'filter')
              .flatMap((c) => chipsOf(c.data_json).map((x) => ({ ...x, id: `${c.key}-${x.label}-${x.value ?? ''}` })))
              .map((x) => (
                <Chip key={x.id} variant="filter" label={x.label} value={x.value} color="gold" />
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
