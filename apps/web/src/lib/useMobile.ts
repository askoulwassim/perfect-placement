import { useEffect, useState } from 'react';

/** Prototype switches to the phone layout below 720px. */
export const MOBILE_QUERY = '(max-width: 719px)';

export function useMobile(): boolean {
  const mq = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(MOBILE_QUERY).matches : false);
  const [m, setM] = useState(mq);
  useEffect(() => {
    if (!window.matchMedia) return;
    const q = window.matchMedia(MOBILE_QUERY);
    const on = () => setM(q.matches);
    q.addEventListener('change', on);
    return () => q.removeEventListener('change', on);
  }, []);
  return m;
}
