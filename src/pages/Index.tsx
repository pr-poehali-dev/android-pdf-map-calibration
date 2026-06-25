import { useState, useRef, useCallback, useEffect } from 'react';
import Icon from '@/components/ui/icon';
import * as pdfjsLib from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

interface ControlPoint {
  id: number;
  label: string;
  px: number;
  py: number;
  lat: string;
  lon: string;
  status: 'fixed' | 'pending';
}

interface PendingPoint { px: number; py: number; }
interface LivePos { lat: number; lon: number; accuracy: number; heading: number | null; }

// Affine calibration: map geo→px using 3+ fixed points
function geoToMapPct(
  lat: number, lon: number,
  pts: ControlPoint[]
): { px: number; py: number } | null {
  const fixed = pts.filter(p => p.status === 'fixed' && p.lat !== '—' && p.lon !== '—');
  if (fixed.length < 3) return null;
  // Simple centroid-based affine (least squares with 3 pts)
  const p = fixed.slice(0, 3);
  const [la0, lo0, la1, lo1, la2, lo2] = [
    parseFloat(p[0].lat), parseFloat(p[0].lon),
    parseFloat(p[1].lat), parseFloat(p[1].lon),
    parseFloat(p[2].lat), parseFloat(p[2].lon),
  ];
  const [px0, py0, px1, py1, px2, py2] = [p[0].px, p[0].py, p[1].px, p[1].py, p[2].px, p[2].py];
  const dLat1 = la1 - la0, dLon1 = lo1 - lo0;
  const dLat2 = la2 - la0, dLon2 = lo2 - lo0;
  const det = dLat1 * dLon2 - dLat2 * dLon1;
  if (Math.abs(det) < 1e-15) return null;
  const dPx1 = px1 - px0, dPy1 = py1 - py0;
  const dPx2 = px2 - px0, dPy2 = py2 - py0;
  const dLat = lat - la0, dLon = lon - lo0;
  const t = (dLat * dLon2 - dLon * dLat2) / det;
  const s = (dLon * dLat1 - dLat * dLon1) / det;
  return {
    px: px0 + t * dPx1 + s * dPx2,
    py: py0 + t * dPy1 + s * dPy2,
  };
}

const tools = [
  { id: 'select', icon: 'MousePointer2', label: 'Выбор' },
  { id: 'point',  icon: 'MapPin',        label: 'Контр. точка' },
  { id: 'distance', icon: 'Ruler',       label: 'Расстояние' },
  { id: 'area',   icon: 'Hexagon',       label: 'Площадь' },
  { id: 'gnss',   icon: 'Satellite',     label: 'GNSS' },
];

let nextId = 5;

const Index = () => {
  const [activeTool, setActiveTool] = useState('point');
  const [selectedPoint, setSelectedPoint] = useState<number | null>(null);
  const [points, setPoints] = useState<ControlPoint[]>([
    { id: 1, label: 'КТ-01', px: 18, py: 22, lat: '55.751244', lon: '37.618423', status: 'fixed' },
    { id: 2, label: 'КТ-02', px: 78, py: 28, lat: '55.752981', lon: '37.621702', status: 'fixed' },
    { id: 3, label: 'КТ-03', px: 30, py: 74, lat: '55.749103', lon: '37.616890', status: 'fixed' },
  ]);

  // PDF
  const [pdfName, setPdfName]   = useState<string | null>(null);
  const [pdfPages, setPdfPages] = useState(0);
  const [pageNum, setPageNum]   = useState(1);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);

  // New-point popup
  const [pending, setPending]       = useState<PendingPoint | null>(null);
  const [latInput, setLatInput]     = useState('');
  const [lonInput, setLonInput]     = useState('');
  const [labelInput, setLabelInput] = useState('');
  const [gnssLoading, setGnssLoading] = useState(false);
  const [gnssAccuracy, setGnssAccuracy] = useState<number | null>(null);
  const [gnssError, setGnssError]   = useState<string | null>(null);

  // Live tracking
  const [tracking, setTracking]     = useState(false);
  const [livePos, setLivePos]       = useState<LivePos | null>(null);
  const [trackError, setTrackError] = useState<string | null>(null);
  const watchIdRef = useRef<number | null>(null);

  const canvasRef    = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mapFrameRef  = useRef<HTMLDivElement>(null);
  const pdfDocRef    = useRef<pdfjsLib.PDFDocumentProxy | null>(null);

  const fixedCount = points.filter(p => p.status === 'fixed').length;

  /* ── PDF ── */
  const renderPage = async (num: number) => {
    const pdf = pdfDocRef.current;
    const canvas = canvasRef.current;
    if (!pdf || !canvas) return;
    const page = await pdf.getPage(num);
    const viewport = page.getViewport({ scale: 2 });
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    await page.render({ canvasContext: ctx, viewport, canvas }).promise;
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.type !== 'application/pdf') { setError('Нужен PDF-файл'); return; }
    setError(null); setLoading(true);
    try {
      const buffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
      pdfDocRef.current = pdf;
      setPdfName(file.name); setPdfPages(pdf.numPages); setPageNum(1);
      await renderPage(1);
    } catch { setError('Не удалось открыть PDF'); }
    finally { setLoading(false); }
  };

  const changePage = async (dir: number) => {
    const next = pageNum + dir;
    if (next < 1 || next > pdfPages) return;
    setPageNum(next); await renderPage(next);
  };

  /* ── Live tracking ── */
  const startTracking = () => {
    if (!navigator.geolocation) { setTrackError('Геолокация не поддерживается браузером'); return; }
    setTrackError(null);
    setTracking(true);
    watchIdRef.current = navigator.geolocation.watchPosition(
      (pos) => {
        setLivePos({
          lat: pos.coords.latitude,
          lon: pos.coords.longitude,
          accuracy: Math.round(pos.coords.accuracy * 10) / 10,
          heading: pos.coords.heading,
        });
        setTrackError(null);
      },
      (err) => {
        const msgs: Record<number, string> = {
          1: 'Доступ к геолокации запрещён',
          2: 'Сигнал GNSS недоступен',
          3: 'Таймаут GNSS',
        };
        setTrackError(msgs[err.code] ?? 'Ошибка GNSS');
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 1000 }
    );
  };

  const stopTracking = () => {
    if (watchIdRef.current !== null) {
      navigator.geolocation.clearWatch(watchIdRef.current);
      watchIdRef.current = null;
    }
    setTracking(false);
  };

  // Cleanup on unmount
  useEffect(() => () => { if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current); }, []);

  // Compute map position of live marker via affine calibration
  const liveMapPos = livePos ? geoToMapPct(livePos.lat, livePos.lon, points) : null;

  /* ── GNSS single capture ── */
  const captureGnss = () => {
    if (!navigator.geolocation) { setGnssError('Геолокация не поддерживается'); return; }
    setGnssLoading(true); setGnssError(null); setGnssAccuracy(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLatInput(pos.coords.latitude.toFixed(7));
        setLonInput(pos.coords.longitude.toFixed(7));
        setGnssAccuracy(Math.round(pos.coords.accuracy * 10) / 10);
        setGnssLoading(false);
      },
      (err) => {
        const msgs: Record<number, string> = {
          1: 'Доступ запрещён — разрешите геолокацию в браузере',
          2: 'Сигнал GNSS недоступен',
          3: 'Таймаут — нет ответа от GNSS',
        };
        setGnssError(msgs[err.code] ?? 'Ошибка GNSS');
        setGnssLoading(false);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  };

  /* ── Click on map ── */
  const handleMapClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (activeTool !== 'point') return;
    if (!pdfName) return;
    const frame = mapFrameRef.current;
    if (!frame) return;
    if ((e.target as HTMLElement).closest('[data-point]')) return;
    const rect = frame.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * 100;
    const py = ((e.clientY - rect.top) / rect.height) * 100;
    const id = nextId++;
    setLabelInput(`КТ-0${id}`);
    setLatInput(''); setLonInput('');
    setGnssAccuracy(null); setGnssError(null);
    setPending({ px, py });
    setSelectedPoint(null);
  }, [activeTool, pdfName]);

  const confirmPoint = () => {
    if (!pending) return;
    const id = nextId - 1;
    setPoints(prev => [...prev, {
      id, label: labelInput || `КТ-0${id}`,
      px: pending.px, py: pending.py,
      lat: latInput || '—', lon: lonInput || '—',
      status: latInput ? 'fixed' : 'pending',
    }]);
    setSelectedPoint(id);
    setPending(null);
  };

  const cancelPoint = () => { nextId--; setPending(null); };

  const deletePoint = (id: number) => {
    setPoints(prev => prev.filter(p => p.id !== id));
    if (selectedPoint === id) setSelectedPoint(null);
  };

  const cursorClass = activeTool === 'point' && pdfName ? 'cursor-crosshair' : 'cursor-default';

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <input ref={fileInputRef} type="file" accept="application/pdf" className="hidden" onChange={handleFile} />

      {/* Top bar */}
      <header className="flex items-center justify-between border-b border-border px-5 h-14 shrink-0 gap-3">
        <div className="flex items-center gap-3 shrink-0">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Icon name="Compass" size={18} />
          </div>
          <div className="leading-tight">
            <div className="font-semibold tracking-tight">GeoCalibrate</div>
            <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">field survey toolkit</div>
          </div>
        </div>

        {/* GNSS live status — center */}
        <div className="flex items-center gap-3">
          {livePos && (
            <div className="hidden items-center gap-2 rounded-full border border-primary/40 bg-primary/10 px-3 py-1.5 md:flex animate-fade-in">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping-slow rounded-full bg-primary" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
              </span>
              <span className="font-mono text-xs text-primary">
                {livePos.lat.toFixed(6)} · {livePos.lon.toFixed(6)}
              </span>
              <span className="font-mono text-xs text-muted-foreground">±{livePos.accuracy} м</span>
            </div>
          )}

          {/* tracking toggle */}
          <button
            onClick={tracking ? stopTracking : startTracking}
            className={`flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium transition-all ${
              tracking
                ? 'border-destructive/50 bg-destructive/15 text-destructive hover:bg-destructive/25'
                : 'border-accent/40 bg-accent/10 text-accent hover:bg-accent/20'
            }`}
          >
            <Icon name={tracking ? 'CircleStop' : 'Navigation'} size={14} />
            {tracking ? 'Стоп' : 'Следить'}
          </button>
        </div>

        <button
          onClick={() => fileInputRef.current?.click()}
          className="flex shrink-0 items-center gap-2 rounded-md bg-primary px-3.5 py-1.5 text-sm font-medium text-primary-foreground transition-transform hover:scale-[1.03]"
        >
          <Icon name="Upload" size={15} />
          Загрузить PDF
        </button>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Tool rail */}
        <nav className="flex w-16 shrink-0 flex-col items-center gap-1 border-r border-border py-4">
          {tools.map((t) => (
            <button
              key={t.id}
              onClick={() => { setActiveTool(t.id); setPending(null); }}
              className={`flex h-12 w-12 flex-col items-center justify-center rounded-lg transition-colors ${
                activeTool === t.id
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
              }`}
              title={t.label}
            >
              <Icon name={t.icon} size={20} />
            </button>
          ))}
          <div className="mt-auto">
            <button className="flex h-12 w-12 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary">
              <Icon name="Settings2" size={20} />
            </button>
          </div>
        </nav>

        {/* Map canvas */}
        <main className="relative flex-1 overflow-auto grid-blueprint-fine">
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-px animate-scan bg-primary/40 shadow-[0_0_12px_2px_hsl(var(--primary)/0.5)]" />

          {/* map frame */}
          <div
            ref={mapFrameRef}
            onClick={handleMapClick}
            className={`absolute inset-8 rounded-lg border border-dashed border-primary/30 ${cursorClass}`}
          >
            <div className="pointer-events-none absolute left-3 top-3 z-20 rounded bg-card/80 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground backdrop-blur">
              {pdfName ?? 'карта не загружена'}
            </div>

            {/* empty state */}
            {!pdfName && !loading && (
              <button
                onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-muted-foreground transition-colors hover:text-primary"
              >
                <Icon name="FileUp" size={48} className="text-primary/60" />
                <div className="text-sm">Перетащите или выберите PDF-карту</div>
                <div className="font-mono text-[11px] text-muted-foreground">.pdf · до 50 МБ</div>
              </button>
            )}

            {loading && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                <Icon name="LoaderCircle" size={36} className="animate-spin text-primary" />
                <div className="font-mono text-xs text-muted-foreground">Рендеринг страницы…</div>
              </div>
            )}

            {/* rendered PDF */}
            <div className={`absolute inset-0 overflow-auto p-2 ${pdfName ? 'block' : 'hidden'}`}>
              <canvas ref={canvasRef} className="mx-auto rounded shadow-2xl" />
            </div>

            {/* control points */}
            {points.map((p) => (
              <div
                key={p.id}
                data-point="true"
                style={{ left: `${p.px}%`, top: `${p.py}%` }}
                className="group absolute z-30 -translate-x-1/2 -translate-y-1/2"
              >
                <button
                  onClick={(e) => { e.stopPropagation(); setSelectedPoint(selectedPoint === p.id ? null : p.id); }}
                  className={`relative flex h-6 w-6 items-center justify-center rounded-full border-2 transition-transform hover:scale-125 ${
                    p.status === 'fixed' ? 'border-primary bg-primary/25' : 'border-accent bg-accent/25 animate-pulse'
                  } ${selectedPoint === p.id ? 'scale-125 ring-2 ring-primary/40' : ''}`}
                >
                  <span className={`h-2 w-2 rounded-full ${p.status === 'fixed' ? 'bg-primary' : 'bg-accent'}`} />
                </button>
                <span className="pointer-events-none absolute left-7 top-1/2 -translate-y-1/2 whitespace-nowrap rounded bg-card/90 px-1.5 py-0.5 font-mono text-[10px] text-foreground">
                  {p.label}
                </span>
                <button
                  data-point="true"
                  onClick={(e) => { e.stopPropagation(); deletePoint(p.id); }}
                  className="absolute -right-2 -top-2 hidden h-4 w-4 items-center justify-center rounded-full bg-destructive text-white group-hover:flex"
                >
                  <Icon name="X" size={10} />
                </button>
              </div>
            ))}

            {/* ── Live position marker ── */}
            {liveMapPos && (
              <div
                style={{ left: `${liveMapPos.px}%`, top: `${liveMapPos.py}%` }}
                className="pointer-events-none absolute z-40 -translate-x-1/2 -translate-y-1/2"
              >
                {/* accuracy circle */}
                <span className="absolute left-1/2 top-1/2 block -translate-x-1/2 -translate-y-1/2 rounded-full border border-accent/40 bg-accent/10"
                  style={{
                    width: `${Math.max(24, Math.min(livePos!.accuracy * 1.5, 120))}px`,
                    height: `${Math.max(24, Math.min(livePos!.accuracy * 1.5, 120))}px`,
                  }}
                />
                {/* pulse ring */}
                <span className="absolute left-1/2 top-1/2 h-8 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent/60 animate-ping-slow" />
                {/* dot */}
                <span className="relative flex h-4 w-4 items-center justify-center rounded-full border-2 border-white bg-accent shadow-lg">
                  <span className="h-1.5 w-1.5 rounded-full bg-white" />
                </span>
                {/* label */}
                <span className="absolute left-5 top-1/2 -translate-y-1/2 whitespace-nowrap rounded bg-accent/90 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-primary-foreground shadow">
                  Я здесь · ±{livePos!.accuracy} м
                </span>
              </div>
            )}

            {/* live pos outside calibrated area notice */}
            {livePos && !liveMapPos && pdfName && fixedCount >= 3 && (
              <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 z-30 flex items-center gap-1.5 rounded-full bg-accent/20 border border-accent/40 px-3 py-1.5 font-mono text-[11px] text-accent">
                <Icon name="Navigation" size={12} /> Позиция за пределами откалиброванной области
              </div>
            )}

            {/* ghost point */}
            {pending && (
              <div style={{ left: `${pending.px}%`, top: `${pending.py}%` }}
                className="pointer-events-none absolute z-30 -translate-x-1/2 -translate-y-1/2"
              >
                <span className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-dashed border-accent bg-accent/20 animate-pulse">
                  <span className="h-2 w-2 rounded-full bg-accent" />
                </span>
              </div>
            )}

            {/* new point popup */}
            {pending && (
              <div
                data-point="true"
                onClick={(e) => e.stopPropagation()}
                style={{ left: `${Math.min(pending.px, 72)}%`, top: `${Math.min(pending.py + 4, 80)}%` }}
                className="absolute z-40 w-64 rounded-xl border border-primary/40 bg-card shadow-2xl animate-fade-in"
              >
                <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
                  <span className="flex items-center gap-2 text-sm font-semibold">
                    <Icon name="MapPin" size={14} className="text-accent" />
                    Новая контрольная точка
                  </span>
                  <button onClick={cancelPoint} className="text-muted-foreground hover:text-foreground">
                    <Icon name="X" size={16} />
                  </button>
                </div>
                <div className="space-y-3 p-4">
                  <div>
                    <label className="mb-1 block font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Название</label>
                    <input autoFocus value={labelInput} onChange={e => setLabelInput(e.target.value)}
                      className="w-full rounded-md border border-border bg-secondary px-3 py-1.5 font-mono text-sm text-foreground outline-none focus:border-primary"
                      placeholder="КТ-05" />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="mb-1 block font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Широта</label>
                      <input value={latInput} onChange={e => setLatInput(e.target.value)}
                        className="w-full rounded-md border border-border bg-secondary px-3 py-1.5 font-mono text-sm text-foreground outline-none focus:border-primary"
                        placeholder="55.7512" />
                    </div>
                    <div>
                      <label className="mb-1 block font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Долгота</label>
                      <input value={lonInput} onChange={e => setLonInput(e.target.value)}
                        className="w-full rounded-md border border-border bg-secondary px-3 py-1.5 font-mono text-sm text-foreground outline-none focus:border-primary"
                        placeholder="37.6184" />
                    </div>
                  </div>

                  <button type="button" onClick={captureGnss} disabled={gnssLoading}
                    className="flex w-full items-center justify-center gap-2 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-sm font-medium text-accent transition-colors hover:bg-accent/20 disabled:opacity-60"
                  >
                    {gnssLoading
                      ? <><Icon name="LoaderCircle" size={15} className="animate-spin" /> Определяю…</>
                      : <><Icon name="Satellite" size={15} /> Снять GNSS</>}
                  </button>

                  {gnssAccuracy !== null && (
                    <div className="flex items-center gap-2 rounded-md bg-primary/10 px-2.5 py-2 font-mono text-[11px] text-primary">
                      <Icon name="CircleCheck" size={13} className="shrink-0" />
                      Точность ±{gnssAccuracy} м
                    </div>
                  )}
                  {gnssError && (
                    <div className="flex items-center gap-2 rounded-md bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive-foreground">
                      <Icon name="TriangleAlert" size={13} className="shrink-0 text-destructive" />
                      {gnssError}
                    </div>
                  )}

                  <div className="flex gap-2">
                    <button onClick={cancelPoint}
                      className="flex-1 rounded-md border border-border py-2 text-sm text-muted-foreground hover:bg-secondary">
                      Отмена
                    </button>
                    <button onClick={confirmPoint}
                      className="flex-1 rounded-md bg-primary py-2 text-sm font-medium text-primary-foreground hover:opacity-90">
                      Добавить
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* page nav */}
          {pdfPages > 1 && (
            <div className="absolute bottom-4 right-4 z-20 flex items-center gap-2 rounded-md border border-border bg-card/80 px-2 py-1.5 font-mono text-xs backdrop-blur">
              <button onClick={() => changePage(-1)} disabled={pageNum === 1} className="rounded p-1 hover:bg-secondary disabled:opacity-30">
                <Icon name="ChevronLeft" size={16} />
              </button>
              <span className="text-muted-foreground">стр. <span className="text-primary">{pageNum}</span> / {pdfPages}</span>
              <button onClick={() => changePage(1)} disabled={pageNum === pdfPages} className="rounded p-1 hover:bg-secondary disabled:opacity-30">
                <Icon name="ChevronRight" size={16} />
              </button>
            </div>
          )}

          {error && (
            <div className="absolute bottom-14 left-1/2 z-20 -translate-x-1/2 flex items-center gap-2 rounded-md border border-destructive bg-destructive/15 px-3 py-2 text-xs text-destructive-foreground">
              <Icon name="TriangleAlert" size={14} /> {error}
            </div>
          )}

          {trackError && (
            <div className="absolute bottom-14 left-1/2 z-20 -translate-x-1/2 flex items-center gap-2 rounded-md border border-destructive bg-destructive/15 px-3 py-2 text-xs text-destructive-foreground">
              <Icon name="TriangleAlert" size={14} /> {trackError}
            </div>
          )}

          {/* tool hint */}
          {activeTool === 'point' && pdfName && !pending && (
            <div className="pointer-events-none absolute bottom-4 left-1/2 z-20 -translate-x-1/2 flex items-center gap-2 rounded-full border border-border bg-card/80 px-3 py-1.5 font-mono text-xs text-muted-foreground backdrop-blur">
              <Icon name="MousePointer2" size={13} className="text-primary" />
              Кликните на карту для добавления контрольной точки
            </div>
          )}

          {/* coords HUD */}
          <div className="absolute bottom-4 left-4 z-20 flex items-center gap-4 rounded-md border border-border bg-card/80 px-3 py-2 font-mono text-xs backdrop-blur">
            {livePos ? (
              <>
                <span className="text-muted-foreground">N <span className="text-primary">{livePos.lat.toFixed(6)}</span></span>
                <span className="text-muted-foreground">E <span className="text-primary">{livePos.lon.toFixed(6)}</span></span>
                <span className="flex items-center gap-1 text-accent">
                  <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" />
                  live ±{livePos.accuracy} м
                </span>
              </>
            ) : (
              <>
                <span className="text-muted-foreground">N <span className="text-foreground/50">—</span></span>
                <span className="text-muted-foreground">E <span className="text-foreground/50">—</span></span>
                <span className="text-muted-foreground">GNSS выкл</span>
              </>
            )}
          </div>
        </main>

        {/* Right panel */}
        <aside className="flex w-80 shrink-0 flex-col border-l border-border">

          {/* Live tracking card */}
          <section className="border-b border-border p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <Icon name="Navigation" size={16} className={tracking ? 'text-accent' : 'text-muted-foreground'} />
                Моё положение
              </h2>
              <button
                onClick={tracking ? stopTracking : startTracking}
                className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-all ${
                  tracking
                    ? 'bg-destructive/20 text-destructive hover:bg-destructive/30'
                    : 'bg-accent/15 text-accent hover:bg-accent/25'
                }`}
              >
                <span className={`h-1.5 w-1.5 rounded-full ${tracking ? 'bg-destructive animate-pulse' : 'bg-accent'}`} />
                {tracking ? 'Остановить' : 'Включить'}
              </button>
            </div>

            {livePos ? (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-lg border border-border bg-secondary/50 p-2.5">
                    <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Широта</div>
                    <div className="font-mono text-sm font-semibold text-foreground">{livePos.lat.toFixed(7)}</div>
                  </div>
                  <div className="rounded-lg border border-border bg-secondary/50 p-2.5">
                    <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Долгота</div>
                    <div className="font-mono text-sm font-semibold text-foreground">{livePos.lon.toFixed(7)}</div>
                  </div>
                </div>
                <div className="flex items-center gap-3 rounded-lg border border-accent/30 bg-accent/5 px-3 py-2">
                  <Icon name="Crosshair" size={16} className="text-accent shrink-0" />
                  <div>
                    <div className="font-mono text-xs font-semibold text-accent">±{livePos.accuracy} м</div>
                    <div className="font-mono text-[10px] text-muted-foreground">точность GNSS</div>
                  </div>
                  {livePos.heading !== null && (
                    <div className="ml-auto text-right">
                      <div className="font-mono text-xs font-semibold text-foreground">{Math.round(livePos.heading)}°</div>
                      <div className="font-mono text-[10px] text-muted-foreground">азимут</div>
                    </div>
                  )}
                </div>
                {!liveMapPos && fixedCount < 3 && (
                  <div className="flex items-center gap-2 rounded-md bg-secondary px-2.5 py-2 text-[11px] text-muted-foreground">
                    <Icon name="Info" size={13} className="shrink-0 text-accent" />
                    Добавьте 3+ привязанных точки для отображения позиции на карте
                  </div>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2 rounded-md bg-secondary px-3 py-2.5 text-xs text-muted-foreground">
                <Icon name="Info" size={14} className="shrink-0 text-accent" />
                {trackError ?? 'Нажмите «Включить» для отслеживания позиции на карте в реальном времени'}
              </div>
            )}
          </section>

          {/* Calibration */}
          <section className="border-b border-border p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <Icon name="Target" size={16} className="text-primary" />
                Калибровка карты
              </h2>
              <span className="font-mono text-xs text-muted-foreground">{fixedCount}/{Math.max(points.length, 4)} точки</span>
            </div>
            <div className="mb-3 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.min((fixedCount / 4) * 100, 100)}%` }} />
            </div>
            <div className="flex items-center gap-2 rounded-md bg-secondary px-3 py-2 text-xs text-muted-foreground">
              <Icon name="Info" size={14} className="shrink-0 text-accent" />
              {fixedCount >= 3
                ? fixedCount >= 4 ? 'Калибровка готова. Позиция отображается на карте.' : 'Аффинная калибровка активна (3 точки).'
                : `Нужно ещё ${3 - fixedCount} точек для калибровки.`}
            </div>
          </section>

          {/* Control points */}
          <section className="flex-1 overflow-y-auto p-5">
            <h3 className="mb-3 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              Контрольные точки ({points.length})
            </h3>
            <div className="space-y-2">
              {points.map((p) => (
                <div key={p.id} onClick={() => setSelectedPoint(selectedPoint === p.id ? null : p.id)}
                  className={`group relative w-full cursor-pointer rounded-lg border p-3 transition-colors ${
                    selectedPoint === p.id ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground/40'
                  }`}
                >
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="flex items-center gap-2 text-sm font-medium">
                      <Icon name="MapPin" size={14} className={p.status === 'fixed' ? 'text-primary' : 'text-accent'} />
                      {p.label}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${
                        p.status === 'fixed' ? 'bg-primary/15 text-primary' : 'bg-accent/15 text-accent'
                      }`}>
                        {p.status === 'fixed' ? 'привязана' : 'ожидает'}
                      </span>
                      <button onClick={(e) => { e.stopPropagation(); deletePoint(p.id); }}
                        className="hidden rounded p-0.5 text-muted-foreground hover:bg-destructive/20 hover:text-destructive group-hover:block">
                        <Icon name="Trash2" size={13} />
                      </button>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-1 font-mono text-[11px] text-muted-foreground">
                    <span>lat {p.lat}</span>
                    <span>lon {p.lon}</span>
                  </div>
                </div>
              ))}
            </div>

            <button onClick={() => setActiveTool('point')}
              className={`mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-dashed py-2.5 text-xs transition-colors ${
                activeTool === 'point'
                  ? 'border-primary bg-primary/5 text-primary'
                  : 'border-border text-muted-foreground hover:border-primary hover:text-primary'
              }`}>
              <Icon name="Plus" size={14} />
              {activeTool === 'point' ? 'Кликните на карту…' : 'Добавить точку на карте'}
            </button>

            <button
              onClick={() => {
                if (!pdfName) return;
                const id = nextId++;
                setLabelInput(`КТ-0${id}`);
                setLatInput(''); setLonInput('');
                setGnssAccuracy(null); setGnssError(null);
                setPending({ px: 50, py: 50 });
                setActiveTool('point');
                setTimeout(() => captureGnss(), 100);
              }}
              disabled={!pdfName}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-accent/40 bg-accent/10 py-2.5 text-xs font-medium text-accent transition-colors hover:bg-accent/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Icon name="Satellite" size={14} />
              Снять точку через GNSS
            </button>
          </section>

          {/* Measurements */}
          <section className="border-t border-border p-5">
            <h3 className="mb-3 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">Измерения</h3>
            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg border border-border p-3">
                <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Icon name="Ruler" size={13} /> Расстояние
                </div>
                <div className="font-mono text-lg font-semibold text-glow text-primary">142.6 м</div>
              </div>
              <div className="rounded-lg border border-border p-3">
                <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Icon name="Hexagon" size={13} /> Площадь
                </div>
                <div className="font-mono text-lg font-semibold text-glow text-primary">0.84 га</div>
              </div>
            </div>
          </section>
        </aside>
      </div>

      <span className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-full bg-[#FF6637] px-4 py-2 text-sm text-white shadow-lg">
        Первая версия — кнопки можно настроить пошагово
      </span>
    </div>
  );
};

export default Index;
