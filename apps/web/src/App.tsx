import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionResponse } from '@remote-webos-tv/contracts';
import { api, ApiFailure, friendlyError } from './api.js';
import { Setup } from './pages/Setup.js';
import { Login } from './pages/Login.js';
import { Home } from './pages/Home.js';

type View = 'loading' | 'setup' | 'login' | 'home' | 'error';

function loginError(cause: unknown): string {
  if (cause instanceof ApiFailure) {
    if (cause.status === 401 && cause.code === 'INVALID_CREDENTIALS') return 'Неверный логин или пароль.';
    if (cause.code === 'INVALID_RESPONSE') return 'Не удалось подтвердить вход: сервер вернул некорректный ответ. Попробуйте снова.';
    if (cause.status === 400) return 'Проверьте логин и пароль: логин — 1–64 символа, пароль — 12–128.';
    if (cause.status === 403) return 'Вход отклонён сервером. Обновите страницу и попробуйте снова.';
  }
  return friendlyError(cause);
}

export function App() {
  const [view, setView] = useState<View>('loading');
  const [session, setSession] = useState<SessionResponse | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [credentialsInvalid, setCredentialsInvalid] = useState(false);
  const [tvActive, setTvActive] = useState(true);
  const pending = useRef(false);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const expireSession = useCallback(() => {
    setSession(null); setView('login'); setTvActive(false);
    setMessage('Сессия истекла. Войдите снова.');
  }, []);

  useEffect(() => { if (message) errorRef.current?.focus(); }, [message]);
  useEffect(() => {
    let active = true;
    async function initialize() {
      try {
        const status = await api.status();
        if (!active) return;
        if (status.state === 'unclaimed') { setView('setup'); return; }
        try {
          const current = await api.session();
          if (active) { setSession(current); setView('home'); }
        } catch (error) {
          if (!active) return;
          if (error instanceof ApiFailure && error.status === 401) setView('login');
          else { setMessage(friendlyError(error)); setView('error'); }
        }
      } catch (error) {
        if (active) { setMessage(friendlyError(error)); setView('error'); }
      }
    }
    void initialize();
    return () => { active = false; };
  }, []);

  async function submit(action: () => Promise<void>, formatError = friendlyError) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setMessage('');
    setCredentialsInvalid(false);
    try { await action(); }
    catch (error) {
      if (error instanceof ApiFailure && error.status === 401 && view === 'home') {
        expireSession();
      } else {
        setCredentialsInvalid(view === 'login' && error instanceof ApiFailure && error.status === 401 && error.code === 'INVALID_CREDENTIALS');
        setMessage(formatError(error));
      }
    } finally { pending.current = false; setBusy(false); }
  }

  const error = message ? <p id="app-error" ref={errorRef} tabIndex={-1} role="alert" className="error">{message}</p> : null;
  return <main className={`shell${view !== 'home' ? ' auth-screen' : ''}`}>
    {view !== 'home' && <header className="auth-header"><p className="eyebrow">Smart TV Remote Hub</p></header>}
    {view === 'loading' && <p className="form-card" role="status">Загрузка…</p>}
    {view === 'error' && <section className="form-card"><h1>Не удалось загрузить приложение</h1>{error}<button type="button" onClick={() => window.location.reload()}>Повторить</button></section>}
    {view === 'setup' && <Setup busy={busy} error={error} onSubmit={(input) => submit(async () => {
      await api.setup(input);
      setView('login');
      setMessage('Владелец создан. Теперь войдите.');
    })} />}
    {view === 'login' && <Login busy={busy} credentialsInvalid={credentialsInvalid} onEdit={() => { setMessage(''); setCredentialsInvalid(false); }} feedback={message === 'Владелец создан. Теперь войдите.' ? message : undefined} error={message === 'Владелец создан. Теперь войдите.' ? null : error} onSubmit={(input) => submit(async () => {
      await api.login(input);
      const current = await api.session();
      setSession(current);
      setTvActive(true);
      setView('home');
    }, loginError)} />}
    {view === 'home' && session && <Home username={session.username} csrfToken={session.csrfToken} tvActive={tvActive} busy={busy} error={error} onSessionExpired={expireSession} onLogout={() => submit(async () => {
      setTvActive(false);
      try { await api.logout(session.csrfToken); }
      catch (cause) { if (!(cause instanceof ApiFailure && cause.status === 401)) setTvActive(true); throw cause; }
      setSession(null);
      setView('login');
    })} />}
  </main>;
}
