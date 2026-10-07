import type { TvDevice, TvId } from '@remote-webos-tv/contracts';
import { IconDeviceDesktop, IconDeviceDesktopPlus, IconPlus, IconCircleFilled } from '@tabler/icons-react';
import { connectionLabels } from '../tv-connection.js';

interface Props { devices: TvDevice[] | null; loading: boolean; error: string; onOpenTv(tvId: TvId): void; onAddTv(): void; onRetry(): void }
export function Dashboard({ devices, loading, error, onOpenTv, onAddTv, onRetry }: Props) {
  return <section className="dashboard" aria-labelledby="dashboard-title">
    <div className="dashboard-heading"><h1 id="dashboard-title">Телевизоры</h1>{!!devices?.length && <button type="button" onClick={onAddTv}><IconPlus aria-hidden="true" />Добавить ТВ</button>}</div>
    {loading ? <p role="status">Загрузка телевизоров…</p> : error ? <div className="dashboard-error"><p role="alert" className="error">{error}</p><button type="button" onClick={onRetry}>Повторить</button></div> : devices?.length ?
      <div className="device-grid">{devices.map(({ tvId, status }) => <article key={tvId} className="device-card">
        <button type="button" className="device-card-main" aria-label={`Открыть телевизор ${status.tv?.identity.model ?? 'ТВ'}`} onClick={() => onOpenTv(tvId)}>
          <span className="device-connection" data-connection={status.connection}><IconCircleFilled aria-hidden="true" />{connectionLabels[status.connection]}</span>
          <IconDeviceDesktop className="device-illustration" stroke={1.2} aria-hidden="true" />
          <h2>{status.tv?.identity.model ?? 'ТВ'}</h2><span className="platform-badge"><img src="/lg-logo.svg" alt="LG" />{status.tv?.identity.platformVersion ? `webOS ${status.tv.identity.platformVersion}` : 'webOS'}</span>
        </button>
      </article>)}</div> : devices ? <div className="dashboard-empty">
        <div className="empty-illustration"><IconDeviceDesktopPlus stroke={1.2} aria-hidden="true" /></div>
        <h2>Пока нет телевизоров</h2><p>Добавьте первый ТВ, чтобы управлять им из браузера.</p>
        <button type="button" className="dashboard-primary" onClick={onAddTv}><IconPlus aria-hidden="true" />Добавить ТВ</button>
        <p className="muted">Телевизор должен быть доступен серверу в вашей сети.</p>
      </div> : null}
  </section>;
}
