import { useEffect, useRef, useState } from 'react';
import { addTvRequestSchema, type TvId } from '@remote-webos-tv/contracts';
import { api, ApiFailure, friendlyError } from '../api.js';
import { requestId } from '../requestId.js';
import { TvSetup } from './TvSetup.js';

interface Props { csrfToken: string; onSessionExpired(): void; onReady(): void }
export function AddTv({ csrfToken, onSessionExpired, onReady }: Props) {
  const [host, setHost] = useState('');
  const [tvId, setTvId] = useState<TvId | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; controller.current?.abort(); }; }, []);
  async function submit() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    controller.current = new AbortController();
    try {
      const input = addTvRequestSchema.safeParse({ id: requestId(), platform: 'webos', host });
      if (!input.success) { setError('Введите локальный IPv4-адрес телевизора без ссылки и номера порта.'); return; }
      const result = await api.addTv(input.data, csrfToken, controller.current.signal);
      if (active.current) setTvId(result.tvId);
    } catch (cause) {
      if (!active.current) return;
      if (cause instanceof ApiFailure && cause.status === 401) onSessionExpired();
      else setError(friendlyError(cause));
    } finally { pending.current = false; if (active.current) setBusy(false); }
  }
  return tvId ? <TvSetup key={tvId} tvId={tvId} csrfToken={csrfToken} onReady={onReady} onSessionExpired={onSessionExpired} settingsOpen={false} onCloseSettings={() => {}} /> : <section className="form-card">
    <h1>Добавить телевизор</h1>
    <p>Включите телевизор и подтвердите доступ на его экране.</p>
    <form noValidate onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label>IP-адрес телевизора<input inputMode="decimal" autoComplete="off" disabled={busy} value={host} onChange={(event) => setHost(event.target.value)} /></label>
      <button type="submit" disabled={busy}>{busy ? 'Подключение…' : 'Подключить'}</button>
    </form>
    {error && <p role="alert" className="error">{error}</p>}
  </section>;
}
