'use client';

import { useEffect, useState } from 'react';

/**
 * Registers the offline service worker.
 *
 * Registration is deferred to `load` and skipped entirely in development:
 * a worker in `next dev` caches the turbopack chunk graph, and every subsequent
 * code change is served stale until the cache is manually cleared — a confusing
 * failure mode that costs far more than offline support is worth while editing.
 *
 * The returned flag drives an unobtrusive "可離線收聽" hint, so the feature is
 * discoverable rather than a hidden background behaviour.
 */
export function useServiceWorker(): { isOfflineReady: boolean } {
  const [isOfflineReady, setIsOfflineReady] = useState<boolean>(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;
    // Registered workers in dev would cache hashed dev assets across rebuilds.
    if (process.env.NODE_ENV !== 'production') return;

    let cancelled = false;

    const register = async () => {
      try {
        const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
        if (cancelled) return;
        setIsOfflineReady(Boolean(registration.active || registration.installing));
      } catch (error) {
        // Offline support is an enhancement; a blocked registration (private
        // mode, policy) must not surface as an error to the reader.
        console.warn('Service worker registration skipped:', error);
      }
    };

    if (document.readyState === 'complete') {
      void register();
    } else {
      window.addEventListener('load', register, { once: true });
    }

    return () => {
      cancelled = true;
      window.removeEventListener('load', register);
    };
  }, []);

  return { isOfflineReady };
}

export default useServiceWorker;
