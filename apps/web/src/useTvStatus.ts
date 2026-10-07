import { useEffect, useRef, useState, useCallback } from 'react';
import type { TvStatusResponse, TvId } from '@remote-webos-tv/contracts';
import { api, ApiFailure, friendlyError } from './api.js';

const pollInterval = 2000;

/** One read at a time. Manual refresh shares the same completion-based cooldown. */
export function useTvStatus(onSessionExpired: () => void, tvId?: TvId, enabled = true) {
  const [snapshot, setSnapshot] = useState<{ status: TvStatusResponse | null; readVersion: number }>({ status: null, readVersion: 0 });
  // Only the initial read blocks the UI; background reads share inFlight below.
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const expired = useRef(onSessionExpired);
  expired.current = onSessionExpired;
  const requestRefresh = useRef<() => void>(() => {});
  const refresh = useCallback(() => requestRefresh.current(), []);
  const startedReads = useRef(0);
  const getReadVersion = useCallback(() => startedReads.current, []);

  useEffect(() => {
    setSnapshot({ status: null, readVersion: 0 }); setError(''); setLoading(enabled); setRefreshing(false);
    if (!enabled) return;
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
      setRefreshing(true);
      const readVersion = ++startedReads.current;
      controller = new AbortController();
      try {
        const next = await api.tvStatus(controller.signal, tvId);
        if (!active) return;
        setSnapshot({ status: next, readVersion });
        setError('');
      } catch (cause) {
        if (!active) return;
        if (cause instanceof ApiFailure && cause.status === 401) {
          active = false;
          expired.current();
        } else {
          setSnapshot({ status: null, readVersion });
          setError(friendlyError(cause));
        }
      } finally {
        inFlight = false;
        if (active) { setLoading(false); setRefreshing(false); schedule(); }
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
  }, [tvId, enabled]);
  return { status: snapshot.status, statusReadVersion: snapshot.readVersion, getReadVersion, loading, refreshing, error, refresh };
}
