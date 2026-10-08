import { IconChevronDown } from '@tabler/icons-react';
import { useEffect, useRef, useState } from 'react';

function cameraError(cause: unknown): string {
  const name = cause instanceof Error ? cause.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Доступ к камере запрещён. Разрешите его в настройках браузера и попробуйте снова.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Выбранная камера не найдена. Подключите камеру или выберите другую.';
  if (name === 'NotReadableError') return 'Камера недоступна. Возможно, её использует другое приложение.';
  return `Не удалось включить камеру${name ? ` (${name})` : ''}. Попробуйте снова.`;
}

export function Webcam() {
  const supported = !!navigator.mediaDevices?.getUserMedia;
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const generation = useRef(0);

  const waitingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function clearWaiting() {
    if (waitingTimer.current !== null) clearTimeout(waitingTimer.current);
    waitingTimer.current = null;
  }

  function release() {
    clearWaiting();
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
    if (video.current) video.current.srcObject = null;
  }
  function stop() {
    generation.current += 1;
    release(); setEnabled(false); setStatus('');
  }
  useEffect(() => () => { generation.current += 1; release(); }, []);

  async function start(selected = deviceId) {
    const request = ++generation.current;
    release(); setEnabled(true); setError(''); setStatus('');
    waitingTimer.current = setTimeout(() => {
      waitingTimer.current = null;
      if (request === generation.current) setStatus('Ожидаем доступ к камере…');
    }, 400);
    try {
      const next = await navigator.mediaDevices.getUserMedia({ audio: false, video: selected ? { deviceId: { exact: selected } } : true });
      if (request !== generation.current) { next.getTracks().forEach((track) => track.stop()); return; }
      clearWaiting();
      stream.current = next;
      if (video.current) video.current.srcObject = next;
      setStatus('');
      try {
        const available = await navigator.mediaDevices.enumerateDevices();
        if (request === generation.current) setDevices(available.filter((device) => device.kind === 'videoinput'));
      } catch (cause) {
        if (request === generation.current) setError(`Видео включено, но список камер недоступен${cause instanceof Error ? ` (${cause.name})` : ''}.`);
      }
    } catch (cause) {
      if (request !== generation.current) return;
      release(); setEnabled(false); setStatus(''); setError(cameraError(cause));
    }
  }

  return <section className="webcam-card" aria-label="Вебкамера">
    <video ref={video} autoPlay muted playsInline aria-label="Видео с вебкамеры" onError={() => { stop(); setError('Не удалось воспроизвести видео с камеры. Попробуйте снова.'); }} />
    <label>Камера<span className="webcam-select"><select value={deviceId} disabled={!supported} onChange={(event) => { const selected = event.target.value; setDeviceId(selected); if (enabled) void start(selected); }}>
      <option value="">По умолчанию</option>
      {devices.map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Камера ${index + 1}`}</option>)}
    </select><IconChevronDown aria-hidden="true" /></span></label>
    <div className="webcam-actions"><button type="button" disabled={!supported} onClick={() => enabled ? stop() : void start()}>{enabled ? 'Выключить' : 'Включить'}</button><div className="webcam-feedback">
    <p className="webcam-status" aria-live="polite">{status}</p>
    {(!supported || error) && <p role={supported ? "alert" : undefined} className="error">{!supported ? 'Браузер не предоставляет доступ к камере. Откройте страницу через HTTPS или localhost.' : error}</p>}
    </div></div>
  </section>;
}
