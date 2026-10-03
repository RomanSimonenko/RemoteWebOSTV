import { useEffect, useRef, useState, useCallback } from 'react';
import type { TvStatusResponse } from '@remote-webos-tv/contracts';
import { api, ApiFailure, friendlyError } from './api.js';

const pollInterval = 2000;

/** One read at a time. Manual refresh shares the same completion-based cooldown. */
export function useTvStatus(onSessionExpired: () => void) {
  const [status, setStatus] = useState<TvStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const expired = useRef(onSessionExpired);
  expired.current = onSessionExpired;
  const requestRefresh = useRef<() => void>(() => {});
  const refresh = useCallback(() => requestRefresh.current(), []);

  useEffect(() => {
    let active = true;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    function schedule() {
      if (active && !inFlight && timer === undefined) timer = setTimeout(() => { timer = undefined; void read(); }, pollInterval);
    }
    async function read() {
      if (!active || inFlight) return;
      inFlight = true;
      controller = new AbortController();
      setLoading(true);
      try {
        const next = await api.tvStatus(controller.signal);
        if (!active) return;
        setStatus(next);
        setError('');
      } catch (cause) {
        if (!active) return;
        if (cause instanceof ApiFailure && cause.status === 401) {
          active = false;
          expired.current();
        } else {
          setStatus(null);
          setError(friendlyError(cause));
        }
      } finally {
        inFlight = false;
        if (active) { setLoading(false); schedule(); }
      }
    }
    requestRefresh.current = schedule;
    void read();
    return () => {
      active = false;
      requestRefresh.current = () => {};
      if (timer !== undefined) clearTimeout(timer);
      controller?.abort();
    };
  }, []);
  return { status, loading, error, refresh };
}
