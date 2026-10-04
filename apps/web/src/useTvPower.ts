import { useCallback, useEffect, useRef, useState } from 'react';
import { tvMacAddressSchema, type TvPowerState } from '@remote-webos-tv/contracts';
import { api, ApiFailure, friendlyError } from './api.js';
import { requestId } from './requestId.js';

interface Runtime {
  active: boolean;
  pending: boolean;
  state: TvPowerState | null;
  startedReads: number;
  invalidatedReads: number;
  read: AbortController | null;
  mutation: AbortController | null;
  refresh(): void;
  stop(): void;
}

export function useTvPower(active: boolean, csrfToken: string, onSessionExpired: () => void) {
  const [state, setState] = useState<TvPowerState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const runtime = useRef<Runtime | null>(null);
  const expired = useRef(onSessionExpired);
  expired.current = onSessionExpired;
  const refresh = useCallback(() => runtime.current?.refresh(), []);

  useEffect(() => {
    setState(null); setError(''); setMessage(''); setBusy(false); setLoading(active);
    if (!active) return;
    let inFlight = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current: Runtime = {
      active: true, pending: false, state: null, startedReads: 0, invalidatedReads: 0, read: null, mutation: null, refresh: schedule,
      stop() {
        current.active = false;
        if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
        current.read?.abort(); current.mutation?.abort();
      },
    };
    runtime.current = current;
    function schedule() {
      if (current.active && !inFlight && timer === undefined) timer = setTimeout(() => { timer = undefined; void read(); }, 2000);
    }
    async function read() {
      if (!current.active || inFlight) return;
      inFlight = true;
      const version = ++current.startedReads;
      current.read = new AbortController();
      try {
        const next = await api.powerState(current.read.signal);
        if (!current.active || version <= current.invalidatedReads) return;
        current.state = next; setState(next); setError(''); setMessage('');
      } catch (cause) {
        if (!current.active) return;
        if (cause instanceof ApiFailure && cause.status === 401) expire(current);
        else if (version > current.invalidatedReads) { current.state = null; setState(null); setError(friendlyError(cause)); }
      } finally {
        inFlight = false;
        if (current.active) { setLoading(false); schedule(); }
      }
    }
    void read();
    return () => { current.stop(); if (runtime.current === current) runtime.current = null; };
  }, [active, csrfToken]);

  function expire(current: Runtime) {
    current.stop(); current.state = null;
    setState(null); setBusy(false); setLoading(false); expired.current();
  }

  async function mutate(current: Runtime, action: (signal: AbortSignal) => Promise<TvPowerState>, failureMessage: (cause: unknown) => string) {
    if (!current.active || current.pending) return;
    current.pending = true; current.mutation = new AbortController(); setBusy(true); setMessage('');
    try {
      const next = await action(current.mutation.signal);
      if (!current.active) return;
      // An in-flight GET predating this response may contain an old operation
      // or MAC. The next GET started afterwards is authoritative across tabs.
      current.invalidatedReads = current.startedReads;
      current.state = next; setState(next); setError('');
    } catch (cause) {
      if (!current.active) return;
      if (cause instanceof ApiFailure && cause.status === 401) expire(current);
      else {
        current.invalidatedReads = current.startedReads;
        current.state = null; setState(null); setMessage(failureMessage(cause));
      }
    } finally {
      current.pending = false;
      if (current.active) { setBusy(false); current.refresh(); }
    }
  }

  function start(action: 'wake' | 'power_off') {
    const current = runtime.current;
    if (!active || !current?.active || current.pending || !current.state || (action === 'wake' ? !current.state.canWake : !current.state.canPowerOff) || current.state.operation?.status === 'running') return;
    let id: string;
    try { id = requestId(); }
    catch { setMessage('Операция не отправлена. Не удалось подготовить идентификатор операции.'); return; }
    const previous = current.state;
    void mutate(current, async (signal) => ({ ...previous, canWake: false, canPowerOff: false, operation: await api.startPower(action === 'wake' ? { id, action } : { id, action, confirm: true }, csrfToken, signal) }),
      (cause) => cause instanceof ApiFailure && cause.powerRejectedBeforeDispatch ? friendlyError(cause) : 'Результат операции неизвестен. Обновляем статус. Автоматический повтор не выполняется.');
  }

  function saveMac(mac: string | null) {
    const current = runtime.current;
    if (!active || !current?.active || current.pending || !current.state || current.state.operation?.status === 'running') return;
    const parsed = tvMacAddressSchema.nullable().safeParse(mac);
    if (!parsed.success) { setMessage('Введите корректный ненулевой unicast MAC-адрес телевизора.'); return; }
    void mutate(current, (signal) => api.setTvMac(parsed.data, csrfToken, signal), friendlyError);
  }

  function cancel(id: string) {
    const current = runtime.current;
    if (!active || !current?.active || current.pending || !current.state || current.state.operation?.id !== id || current.state.operation.status !== 'running') return;
    const previous = current.state;
    void mutate(current, async (signal) => ({ ...previous, canWake: false, canPowerOff: false, operation: await api.cancelPower(id, csrfToken, signal) }), friendlyError);
  }

  return { state, loading, error, message, busy, refresh, start, saveMac, cancel };
}
