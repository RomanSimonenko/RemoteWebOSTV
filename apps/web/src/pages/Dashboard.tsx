import type { TvDevice, TvId } from '@remote-webos-tv/contracts';
import { IconDeviceDesktop, IconDeviceDesktopPlus, IconPlus, IconCircleFilled, IconTrash } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';
import { SettingsDialog } from '../components/SettingsDialog.js';
import { friendlyError } from '../api.js';
import { connectionLabels } from '../tv-connection.js';
import { TvBrand, tvPlatformLabel } from '../tv-presentation.js';

interface Props { devices: TvDevice[] | null; loading: boolean; error: string; onOpenTv(tvId: TvId): void; onAddTv(): void; onRetry(): void; onDeleteTv(tvId: TvId, signal: AbortSignal): Promise<void> }
export function Dashboard({ devices, loading, error, onOpenTv, onAddTv, onRetry, onDeleteTv }: Props) {
  const [selected, setSelected] = useState<TvDevice | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const controller = useRef<AbortController | null>(null);
  const active = useRef(true);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusAfterDelete = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => { if (!selected && focusAfterDelete.current) { focusAfterDelete.current = false; heading.current?.focus(); } }, [selected]);
  function dismiss() { if (!controller.current) { setSelected(null); setDeleteError(''); } }
  async function confirmDelete() {
    if (!selected || controller.current) return;
    const current = new AbortController(); controller.current = current; setDeleting(true); setDeleteError('');
    try { await onDeleteTv(selected.tvId, current.signal); if (active.current) { focusAfterDelete.current = true; setSelected(null); } }
    catch (cause) { if (active.current) setDeleteError(friendlyError(cause)); }
    finally { if (controller.current === current) controller.current = null; if (active.current) setDeleting(false); }
  }
  return <section className="dashboard" aria-labelledby="dashboard-title">
    <div className="dashboard-heading"><h1 ref={heading} tabIndex={-1} id="dashboard-title">Телевизоры</h1>{!!devices?.length && <button type="button" onClick={onAddTv}><IconPlus aria-hidden="true" />Добавить ТВ</button>}</div>
    {loading ? <p role="status">Загрузка телевизоров…</p> : error ? <div className="dashboard-error"><p role="alert" className="error">{error}</p><button type="button" onClick={onRetry}>Повторить</button></div> : devices?.length ?
      <div className="device-grid">{devices.map(({ tvId, platform, status }) => <article key={tvId} className="device-card">
        <button type="button" className="device-delete" aria-label={`Удалить телевизор ${status.tv?.identity.model ?? 'ТВ'}`} title="Удалить телевизор" aria-haspopup="dialog" onClick={() => { setDeleteError(''); setSelected(devices.find(device => device.tvId === tvId)!); }}><IconTrash aria-hidden="true" /></button>
        <button type="button" className="device-card-main" aria-label={`Открыть телевизор ${status.tv?.identity.model ?? 'ТВ'}`} onClick={() => onOpenTv(tvId)}>
          <span className="device-connection" data-connection={status.connection}><IconCircleFilled aria-hidden="true" />{connectionLabels[status.connection]}</span>
          <IconDeviceDesktop className="device-illustration" stroke={1.2} aria-hidden="true" />
          <h2>{status.tv?.identity.model ?? 'ТВ'}</h2><span className="platform-badge"><TvBrand platform={platform} /><span>{tvPlatformLabel(platform, status.tv?.identity)}</span></span>
        </button>
      </article>)}</div> : devices ? <div className="dashboard-empty">
        <div className="empty-illustration"><IconDeviceDesktopPlus stroke={1.2} aria-hidden="true" /></div>
        <h2>Пока нет телевизоров</h2><p>Добавьте первый ТВ, чтобы управлять им из браузера.</p>
        <button type="button" className="dashboard-primary" onClick={onAddTv}><IconPlus aria-hidden="true" />Добавить ТВ</button>
        <p className="muted">Телевизор должен быть доступен серверу в вашей сети.</p>
      </div> : null}
    <SettingsDialog title="Удалить телевизор?" closeLabel="Отменить удаление" open={selected !== null} onClose={dismiss}>
      <p>Телевизор «{selected?.status.tv?.identity.model ?? 'ТВ'}» и его данные подключения будут удалены из приложения. Для добавления потребуется новое сопряжение.</p>
      <p className="muted">Сам телевизор не будет выключен, его настройки не изменятся.</p>
      {deleteError && <p role="alert" className="error">{deleteError}</p>}
      <div className="delete-tv-actions"><button type="button" disabled={deleting} onClick={dismiss}>Отмена</button><button type="button" className="delete-tv-confirm" disabled={deleting} onClick={() => void confirmDelete()}>{deleting ? 'Удаление…' : 'Удалить'}</button></div>
    </SettingsDialog>
  </section>;
}
