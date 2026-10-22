'use client';

import { useSyncExternalStore } from 'react';

import { dayIndexFor, msUntilNextDay } from './dailyPicks';

/**
 * Hydration gate.
 *
 * The daily picks depend on the current date, which the server cannot know in
 * the visitor's timezone and which can legitimately differ between the SSR pass
 * and the client's first paint (a page served at 23:59:59). Rendering the
 * section only after hydration removes that whole class of mismatch instead of
 * papering over it, at the cost of one extra render.
 *
 * `useSyncExternalStore` is used rather than `useState` + `useEffect` because
 * writing state from an effect for something that is knowable immediately is
 * the pattern this codebase's lint rules reject, and the server snapshot has to
 * be `false` explicitly — that is exactly what this API is for.
 */
const subscribeNever = () => () => {};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

export function useIsHydrated(): boolean {
  return useSyncExternalStore(subscribeNever, clientSnapshot, serverSnapshot);
}

/**
 * The current UTC+8 day index, re-read at every local midnight.
 *
 * The subscription arms a timer for the next midnight and notifies once it
 * fires, so a page left open overnight rotates to the new picks without a
 * reload. The snapshot is a plain number that is constant for the whole day, so
 * repeated reads by React cannot cause a render loop.
 */
let listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;

function notifyAll() {
  for (const listener of listeners) listener();
}

function armMidnightTimer() {
  if (typeof window === 'undefined') return;
  if (timer !== null) return;
  // Nothing is listening (every consumer unmounted), so there is no reason to
  // keep a timer alive until the next midnight.
  if (listeners.size === 0) return;

  const delay = msUntilNextDay(Date.now());
  timer = setTimeout(() => {
    timer = null;
    notifyAll();
    // Re-arm for the following midnight. `notifyAll` can unsubscribe the last
    // listener, in which case `armMidnightTimer` now returns without scheduling
    // anything instead of leaving an orphan timer running forever.
    armMidnightTimer();
  }, delay);
  // Timers must not hold a Node process open in tests.
  if (typeof timer === 'object' && timer && 'unref' in timer) {
    (timer as unknown as { unref: () => void }).unref();
  }
}

function subscribeDay(callback: () => void): () => void {
  listeners.add(callback);
  armMidnightTimer();
  return () => {
    listeners.delete(callback);
    if (listeners.size === 0 && timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

const daySnapshot = () => dayIndexFor(Date.now());
// The section is hidden until hydration, so the server value is never rendered;
// it only has to be a valid, stable number.
const serverDaySnapshot = () => 0;

export function useDayIndex(): number {
  return useSyncExternalStore(subscribeDay, daySnapshot, serverDaySnapshot);
}

/** Test-only: clears module state between cases. */
export function __resetDayStore(): void {
  listeners = new Set();
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}
