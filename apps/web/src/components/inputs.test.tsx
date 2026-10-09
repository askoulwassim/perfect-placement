import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { compRange } from '../lib/format';
import { chipsOf, defaultsInput, defaultsText } from '../lib/profile';
import { addEntries, ChipInput, formatUnit, parseUnit, SliderInput, splitEntries } from './inputs';

function Chips({ initial = [] as string[], max }: { initial?: string[]; max?: number }) {
  const [v, setV] = useState(initial);
  return (
    <>
      <ChipInput label="Companies" value={v} onChange={setV} {...(max != null ? { max } : {})} />
      <output data-testid="out">{JSON.stringify(v)}</output>
    </>
  );
}
const out = () => JSON.parse(screen.getByTestId('out').textContent ?? '[]') as string[];
const entry = () => screen.getByRole('textbox', { name: 'Companies' }) as HTMLInputElement;

describe('ChipInput (#75)', () => {
  it('Enter and Tab commit a chip; empty Enter does nothing', () => {
    render(<Chips />);
    fireEvent.change(entry(), { target: { value: 'Anthropic' } });
    fireEvent.keyDown(entry(), { key: 'Enter' });
    expect(out()).toEqual(['Anthropic']);
    expect(entry().value).toBe('');
    fireEvent.change(entry(), { target: { value: ' Stripe ' } });
    fireEvent.keyDown(entry(), { key: 'Tab' });
    expect(out()).toEqual(['Anthropic', 'Stripe']);
    fireEvent.keyDown(entry(), { key: 'Enter' });
    expect(out()).toEqual(['Anthropic', 'Stripe']);
  });

  it('Backspace on an empty entry removes the last chip; x removes one', () => {
    render(<Chips initial={['A', 'B', 'C']} />);
    fireEvent.change(entry(), { target: { value: 'x' } });
    fireEvent.keyDown(entry(), { key: 'Backspace' });
    expect(out()).toEqual(['A', 'B', 'C']);
    fireEvent.change(entry(), { target: { value: '' } });
    fireEvent.keyDown(entry(), { key: 'Backspace' });
    expect(out()).toEqual(['A', 'B']);
    const x = screen.getByRole('button', { name: 'Remove A' });
    expect(x.getAttribute('data-op')).toBe('local');
    fireEvent.click(x);
    expect(out()).toEqual(['B']);
  });

  it('paste splits on commas and new lines; duplicates are ignored', () => {
    render(<Chips initial={['Figma']} />);
    fireEvent.paste(entry(), { clipboardData: { getData: () => 'Linear, figma\nVercel\n\nLinear' } });
    expect(out()).toEqual(['Figma', 'Linear', 'Vercel']);
    fireEvent.change(entry(), { target: { value: 'VERCEL' } });
    fireEvent.keyDown(entry(), { key: 'Enter' });
    expect(out()).toEqual(['Figma', 'Linear', 'Vercel']);
  });

  it('blur commits what is typed; max caps the list', () => {
    render(<Chips initial={['A']} max={2} />);
    fireEvent.change(entry(), { target: { value: 'B' } });
    fireEvent.blur(entry());
    expect(out()).toEqual(['A', 'B']);
    expect(entry().disabled).toBe(true);
  });

  it('helpers', () => {
    expect(splitEntries('a, b\nc,,')).toEqual(['a', 'b', 'c']);
    expect(addEntries(['a'], ['A', 'b', ' ', 'c'], 2)).toEqual(['a', 'b']);
  });
});

function Slider({ initial = 300000 }: { initial?: number }) {
  const [v, setV] = useState(initial);
  return <SliderInput label="Floor" unit="money" min={0} max={600000} step={1000} value={v} onChange={setV} />;
}
const slider = () => screen.getByRole('slider', { name: 'Floor' }) as HTMLInputElement;
const exact = () => screen.getByRole('textbox', { name: 'Floor (exact)' }) as HTMLInputElement;
const shown = (c: HTMLElement) => c.querySelector('.slider-input__value')?.textContent;

describe('SliderInput (#73)', () => {
  it('typing an exact value moves the slider; the slider continues from there', () => {
    const { container } = render(<Slider />);
    expect(shown(container)).toBe('$300k');
    expect(slider().step).toBe('1000');
    fireEvent.change(exact(), { target: { value: '212500' } });
    expect(shown(container)).toBe('$212.5k');
    expect(slider().value).toBe('212500');
    fireEvent.blur(exact());
    expect(exact().value).toBe('212,500');
    // Shift moves 5k.
    fireEvent.keyDown(slider(), { key: 'ArrowRight', shiftKey: true });
    expect(shown(container)).toBe('$217.5k');
    fireEvent.change(slider(), { target: { value: '218000' } });
    expect(shown(container)).toBe('$218k');
    expect(exact().value).toBe('218,000');
    expect(container.textContent).not.toMatch(/\d,\d{3}k/i);
  });

  it('accepts 212.5k and clamps to the bounds on leave', () => {
    const { container } = render(<Slider />);
    fireEvent.change(exact(), { target: { value: '212.5k' } });
    expect(shown(container)).toBe('$212.5k');
    fireEvent.change(exact(), { target: { value: '900000' } });
    fireEvent.blur(exact());
    expect(shown(container)).toBe('$600k');
  });

  it('formats percent and parses units', () => {
    expect(formatUnit(40, 'percent')).toBe('40%');
    expect(parseUnit('40%', 'percent')).toBe(40);
    expect(parseUnit('$212,500', 'money')).toBe(212500);
  });
});

describe('comp displays (#73)', () => {
  it('role facts, profile chips and defaults use the shared formatter', () => {
    expect(compRange({ comp_min: 212500, comp_max: 300000 })).toBe('$212.5k to $300k');
    expect(compRange({ comp_min: null, comp_max: null })).toBeNull();
    expect(chipsOf({ comp_floor: 300000, comp_target: 212500, travel_max_pct: 20 })).toEqual([
      { label: 'Comp floor', value: '$300k' },
      { label: 'Comp target', value: '$212.5k' },
      { label: 'Travel max pct', value: '20' },
    ]);
    const t = defaultsText({ comp_expectation: '300,000k' });
    expect(defaultsInput(t).comp_expectation).toBe('$300,000');
    expect(defaultsInput({ ...t, comp_expectation: 'Open, around 300k base' }).comp_expectation).toBe('Open, around 300k base');
  });
});
