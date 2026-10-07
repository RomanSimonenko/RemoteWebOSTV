import { useCallback, useEffect, useRef, useState } from 'react';
import type { TvDevice, TvId } from '@remote-webos-tv/contracts';
import { api, ApiFailure, friendlyError } from './api.js';

/** Only the dashboard owns list polling. Cleanup rejects replies from old screens. */
export function useTvDevices(onSessionExpired: () => void, enabled = true) {
  const [devices, setDevices] = useState<TvDevice[] | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState('');
  const expired = useRef(onSessionExpired);
  expired.current = onSessionExpired;
  const requestRefresh = useRef<() => void>(() => {});
  const revision = useRef(0);
  const remove = useCallback((tvId: TvId) => {
    revision.current++;
    setDevices(current => current?.filter(device => device.tvId !== tvId) ?? null);
    requestRefresh.current();
  }, []);
  const refresh = useCallback(() => requestRefresh.current(), []);
  useEffect(() => {
    setDevices(null); setError(''); setLoading(enabled);
    if (!enabled) return;
    let active = true;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    function schedule() {
      if (active && !inFlight && timer === undefined) timer = setTimeout(() => { timer = undefined; void read(); }, 2000);
    }
    async function read() {
      if (!active || inFlight) return;
      inFlight = true;
      const version = revision.current;
      controller = new AbortController();
      try {
        const next = await api.tvDevices(controller.signal);
        if (!active || version !== revision.current) return;
        setDevices(next.devices); setError('');
      } catch (cause) {
        if (!active) return;
        if (cause instanceof ApiFailure && cause.status === 401) { active = false; expired.current(); }
        else if (version === revision.current) setError(friendlyError(cause));
      } finally {
        inFlight = false;
        if (active) { setLoading(false); schedule(); }
      }
    }
    requestRefresh.current = schedule;
    void read();
    return () => { active = false; requestRefresh.current = () => {}; if (timer !== undefined) clearTimeout(timer); controller?.abort(); };
  }, [enabled]);
  return { devices, loading, error, refresh, remove };
}
