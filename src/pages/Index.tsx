import { useState, useRef, useCallback, useEffect } from 'react';
import Icon from '@/components/ui/icon';
import * as pdfjsLib from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { wgsToMsk64, msk64ToWgs, toDms, MSK64_PARAMS } from '@/lib/coords';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

type CoordSys = 'WGS84' | 'MSK64';

interface ControlPoint {
  id: number;
  label: string;
  px: number;
  py: number;
  lat: string; // всегда WGS-84 внутри
  lon: string;
  status: 'fixed' | 'pending';
}

interface PendingPoint { px: number; py: number; }
interface LivePos { lat: number; lon: number; accuracy: number; heading: number | null; }

// ── Аффинная калибровка: WGS-84 geo → % на карте ──────────────────────────
function geoToMapPct(lat: number, lon: number, pts: ControlPoint[]) {
  const fixed = pts.filter(p => p.status === 'fixed' && p.lat !== '—' && p.lon !== '—');
  if (fixed.length < 3) return null;
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
  const dLat = lat - la0, dLon = lon - lo0;
  const t = (dLat * dLon2 - dLon * dLat2) / det;
  const s = (dLon * dLat1 - dLat * dLon1) / det;
  return {
    px: px0 + t * (px1 - px0) + s * (px2 - px0),
    py: py0 + t * (py1 - py0) + s * (py2 - py0),
  };
}

// ── Форматирование координат для отображения ──────────────────────────────
function formatCoord(lat: string, lon: string, sys: CoordSys): { line1: string; line2: string } {
  if (lat === '—' || lon === '—') return { line1: '—', line2: '—' };
  const la = parseFloat(lat), lo = parseFloat(lon);
  if (isNaN(la) || isNaN(lo)) return { line1: '—', line2: '—' };
  if (sys === 'WGS84') {
    return { line1: `φ ${la.toFixed(7)}°`, line2: `λ ${lo.toFixed(7)}°` };
  }
  const m = wgsToMsk64(la, lo);
  return { line1: `X ${m.X.toFixed(2)} м`, line2: `Y ${m.Y.toFixed(2)} м` };
}

function formatLive(pos: LivePos, sys: CoordSys) {
  if (sys === 'WGS84') {
    return { a: `${pos.lat.toFixed(7)}°`, b: `${pos.lon.toFixed(7)}°`, la: 'φ', lb: 'λ' };
  }
  const m = wgsToMsk64(pos.lat, pos.lon);
  return { a: `${m.X.toFixed(2)} м`, b: `${m.Y.toFixed(2)} м`, la: 'X', lb: 'Y' };
}

const tools = [
  { id: 'select',   icon: 'MousePointer2', label: 'Выбор' },
  { id: 'point',    icon: 'MapPin',        label: 'Контр. точка' },
  { id: 'distance', icon: 'Ruler',         label: 'Расстояние' },
  { id: 'area',     icon: 'Hexagon',       label: 'Площадь' },
  { id: 'gnss',     icon: 'Satellite',     label: 'GNSS' },
];

let nextId = 5;

const Index = () => {
  const [activeTool, setActiveTool]       = useState('point');
  const [selectedPoint, setSelectedPoint] = useState<number | null>(null);
  const [coordSys, setCoordSys]           = useState<CoordSys>('WGS84');

  const [points, setPoints] = useState<ControlPoint[]>([
    { id: 1, label: 'КТ-01', px: 18, py: 22, lat: '59.951244', lon: '30.318423', status: 'fixed' },
    { id: 2, label: 'КТ-02', px: 78, py: 28, lat: '59.952981', lon: '30.321702', status: 'fixed' },
    { id: 3, label: 'КТ-03', px: 30, py: 74, lat: '59.949103', lon: '30.316890', status: 'fixed' },
  ]);

  // PDF
  const [pdfName, setPdfName]   = useState<string | null>(null);
  const [pdfPages, setPdfPages] = useState(0);
  const [pageNum, setPageNum]   = useState(1);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);

  // New-point popup
  const [pending, setPending]           = useState<PendingPoint | null>(null);
  const [inputA, setInputA]             = useState(''); // lat или X
  const [inputB, setInputB]             = useState(''); // lon или Y
  const [labelInput, setLabelInput]     = useState('');
  const [gnssLoading, setGnssLoading]   = useState(false);
  const [gnssAccuracy, setGnssAccuracy] = useState<number | null>(null);
  const [gnssError, setGnssError]       = useState<string | null>(null);

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

  // Конвертируем введённые координаты в WGS-84 для хранения
  const inputToWgs = (): { lat: string; lon: string } | null => {
    if (!inputA || !inputB) return null;
    const a = parseFloat(inputA), b = parseFloat(inputB);
    if (isNaN(a) || isNaN(b)) return null;
    if (coordSys === 'WGS84') return { lat: String(a), lon: String(b) };
    const wgs = msk64ToWgs(a, b);
    return { lat: wgs.lat.toFixed(7), lon: wgs.lon.toFixed(7) };
  };

  /* ── PDF ── */
  const renderPage = async (num: number) => {
    const pdf = pdfDocRef.current;
    const canvas = canvasRef.current;
    if (!pdf || !canvas) return;
    const page = await pdf.getPage(num);
    const viewport = page.getViewport({ scale: 2 });
    canvas.width = viewport.width; canvas.height = viewport.height;
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
      const buf = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
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
    if (!navigator.geolocation) { setTrackError('Геолокация не поддерживается'); return; }
    setTrackError(null); setTracking(true);
    watchIdRef.current = navigator.geolocation.watchPosition(
      pos => {
        setLivePos({ lat: pos.coords.latitude, lon: pos.coords.longitude,
          accuracy: Math.round(pos.coords.accuracy * 10) / 10, heading: pos.coords.heading });
        setTrackError(null);
      },
      err => {
        const msgs: Record<number, string> = { 1: 'Доступ запрещён', 2: 'Нет сигнала GNSS', 3: 'Таймаут GNSS' };
        setTrackError(msgs[err.code] ?? 'Ошибка GNSS');
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 1000 }
    );
  };

  const stopTracking = () => {
    if (watchIdRef.current !== null) { navigator.geolocation.clearWatch(watchIdRef.current); watchIdRef.current = null; }
    setTracking(false);
  };

  useEffect(() => () => { if (watchIdRef.current !== null) navigator.geolocation.clearWatch(watchIdRef.current); }, []);

  const liveMapPos = livePos ? geoToMapPct(livePos.lat, livePos.lon, points) : null;

  /* ── GNSS single capture ── */
  const captureGnss = () => {
    if (!navigator.geolocation) { setGnssError('Геолокация не поддерживается'); return; }
    setGnssLoading(true); setGnssError(null); setGnssAccuracy(null);
    navigator.geolocation.getCurrentPosition(
      pos => {
        const la = pos.coords.latitude, lo = pos.coords.longitude;
        if (coordSys === 'WGS84') {
          setInputA(la.toFixed(7)); setInputB(lo.toFixed(7));
        } else {
          const m = wgsToMsk64(la, lo);
          setInputA(m.X.toFixed(2)); setInputB(m.Y.toFixed(2));
        }
        setGnssAccuracy(Math.round(pos.coords.accuracy * 10) / 10);
        setGnssLoading(false);
      },
      err => {
        const msgs: Record<number, string> = { 1: 'Доступ запрещён', 2: 'Нет сигнала', 3: 'Таймаут' };
        setGnssError(msgs[err.code] ?? 'Ошибка GNSS'); setGnssLoading(false);
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  };

  /* ── Click on map ── */
  const handleMapClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (activeTool !== 'point' || !pdfName) return;
    if ((e.target as HTMLElement).closest('[data-point]')) return;
    const frame = mapFrameRef.current;
    if (!frame) return;
    const rect = frame.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * 100;
    const py = ((e.clientY - rect.top) / rect.height) * 100;
    const id = nextId++;
    setLabelInput(`КТ-0${id}`);
    setInputA(''); setInputB(''); setGnssAccuracy(null); setGnssError(null);
    setPending({ px, py }); setSelectedPoint(null);
  }, [activeTool, pdfName]);

  const confirmPoint = () => {
    if (!pending) return;
    const id = nextId - 1;
    const wgs = inputToWgs();
    setPoints(prev => [...prev, {
      id, label: labelInput || `КТ-0${id}`,
      px: pending.px, py: pending.py,
      lat: wgs?.lat ?? '—', lon: wgs?.lon ?? '—',
      status: wgs ? 'fixed' : 'pending',
    }]);
    setSelectedPoint(id); setPending(null);
  };

  const cancelPoint = () => { nextId--; setPending(null); };

  const deletePoint = (id: number) => {
    setPoints(prev => prev.filter(p => p.id !== id));
    if (selectedPoint === id) setSelectedPoint(null);
  };

  const cursorClass = activeTool === 'point' && pdfName ? 'cursor-crosshair' : 'cursor-default';

  // Лейблы полей ввода
  const fieldLabels = coordSys === 'WGS84'
    ? { a: 'Широта φ (°)', b: 'Долгота λ (°)', pa: '59.9512', pb: '30.3184' }
    : { a: 'X (м север)', b: 'Y (м восток)', pa: '248500.00', pb: '53200.00' };

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <input ref={fileInputRef} type="file" accept="application/pdf" className="hidden" onChange={handleFile} />

      {/* ── Top bar ── */}
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

        {/* Coord system toggle */}
        <div className="flex items-center rounded-lg border border-border bg-card p-0.5 font-mono text-xs">
          {(['WGS84', 'MSK64'] as CoordSys[]).map(s => (
            <button
              key={s}
              onClick={() => setCoordSys(s)}
              className={`rounded-md px-3 py-1.5 transition-colors ${
                coordSys === s
                  ? 'bg-primary text-primary-foreground font-semibold'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {s === 'WGS84' ? 'WGS-84' : 'МСК-1964'}
            </button>
          ))}
        </div>

        {/* Live GNSS status */}
        {livePos && (
          <div className="hidden items-center gap-2 rounded-full border border-primary/40 bg-primary/10 px-3 py-1.5 md:flex animate-fade-in">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping-slow rounded-full bg-primary" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
            </span>
            {coordSys === 'WGS84' ? (
              <span className="font-mono text-xs text-primary">
                {livePos.lat.toFixed(5)}° · {livePos.lon.toFixed(5)}°
              </span>
            ) : (() => {
              const m = wgsToMsk64(livePos.lat, livePos.lon);
              return (
                <span className="font-mono text-xs text-primary">
                  X {m.X.toFixed(1)} · Y {m.Y.toFixed(1)}
                </span>
              );
            })()}
            <span className="font-mono text-xs text-muted-foreground">±{livePos.accuracy} м</span>
          </div>
        )}

        <div className="flex items-center gap-2 shrink-0">
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

          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-2 rounded-md bg-primary px-3.5 py-1.5 text-sm font-medium text-primary-foreground transition-transform hover:scale-[1.03]"
          >
            <Icon name="Upload" size={15} />
            Загрузить PDF
          </button>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* ── Tool rail ── */}
        <nav className="flex w-16 shrink-0 flex-col items-center gap-1 border-r border-border py-4">
          {tools.map(t => (
            <button key={t.id} onClick={() => { setActiveTool(t.id); setPending(null); }}
              className={`flex h-12 w-12 items-center justify-center rounded-lg transition-colors ${
                activeTool === t.id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
              }`} title={t.label}>
              <Icon name={t.icon} size={20} />
            </button>
          ))}
          <div className="mt-auto">
            <button className="flex h-12 w-12 items-center justify-center rounded-lg text-muted-foreground hover:bg-secondary">
              <Icon name="Settings2" size={20} />
            </button>
          </div>
        </nav>

        {/* ── Map canvas ── */}
        <main className="relative flex-1 overflow-auto grid-blueprint-fine">
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-px animate-scan bg-primary/40 shadow-[0_0_12px_2px_hsl(var(--primary)/0.5)]" />

          <div ref={mapFrameRef} onClick={handleMapClick}
            className={`absolute inset-8 rounded-lg border border-dashed border-primary/30 ${cursorClass}`}>

            <div className="pointer-events-none absolute left-3 top-3 z-20 rounded bg-card/80 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground backdrop-blur">
              {pdfName ?? 'карта не загружена'}
            </div>

            {!pdfName && !loading && (
              <button onClick={e => { e.stopPropagation(); fileInputRef.current?.click(); }}
                className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-muted-foreground hover:text-primary transition-colors">
                <Icon name="FileUp" size={48} className="text-primary/60" />
                <div className="text-sm">Перетащите или выберите PDF-карту</div>
                <div className="font-mono text-[11px] text-muted-foreground">.pdf · до 50 МБ</div>
              </button>
            )}

            {loading && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                <Icon name="LoaderCircle" size={36} className="animate-spin text-primary" />
                <div className="font-mono text-xs text-muted-foreground">Рендеринг…</div>
              </div>
            )}

            <div className={`absolute inset-0 overflow-auto p-2 ${pdfName ? 'block' : 'hidden'}`}>
              <canvas ref={canvasRef} className="mx-auto rounded shadow-2xl" />
            </div>

            {/* Control points */}
            {points.map(p => (
              <div key={p.id} data-point="true" style={{ left: `${p.px}%`, top: `${p.py}%` }}
                className="group absolute z-30 -translate-x-1/2 -translate-y-1/2">
                <button onClick={e => { e.stopPropagation(); setSelectedPoint(selectedPoint === p.id ? null : p.id); }}
                  className={`relative flex h-6 w-6 items-center justify-center rounded-full border-2 transition-transform hover:scale-125 ${
                    p.status === 'fixed' ? 'border-primary bg-primary/25' : 'border-accent bg-accent/25 animate-pulse'
                  } ${selectedPoint === p.id ? 'scale-125 ring-2 ring-primary/40' : ''}`}>
                  <span className={`h-2 w-2 rounded-full ${p.status === 'fixed' ? 'bg-primary' : 'bg-accent'}`} />
                </button>
                <span className="pointer-events-none absolute left-7 top-1/2 -translate-y-1/2 whitespace-nowrap rounded bg-card/90 px-1.5 py-0.5 font-mono text-[10px] text-foreground">
                  {p.label}
                </span>
                <button data-point="true" onClick={e => { e.stopPropagation(); deletePoint(p.id); }}
                  className="absolute -right-2 -top-2 hidden h-4 w-4 items-center justify-center rounded-full bg-destructive text-white group-hover:flex">
                  <Icon name="X" size={10} />
                </button>
              </div>
            ))}

            {/* Live position marker */}
            {liveMapPos && (
              <div style={{ left: `${liveMapPos.px}%`, top: `${liveMapPos.py}%` }}
                className="pointer-events-none absolute z-40 -translate-x-1/2 -translate-y-1/2">
                <span className="absolute left-1/2 top-1/2 block -translate-x-1/2 -translate-y-1/2 rounded-full border border-accent/40 bg-accent/10"
                  style={{ width: `${Math.max(24, Math.min(livePos!.accuracy * 1.5, 120))}px`, height: `${Math.max(24, Math.min(livePos!.accuracy * 1.5, 120))}px` }} />
                <span className="absolute left-1/2 top-1/2 h-8 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-accent/60 animate-ping-slow" />
                <span className="relative flex h-4 w-4 items-center justify-center rounded-full border-2 border-white bg-accent shadow-lg">
                  <span className="h-1.5 w-1.5 rounded-full bg-white" />
                </span>
                <span className="absolute left-5 top-1/2 -translate-y-1/2 whitespace-nowrap rounded bg-accent/90 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-primary-foreground shadow">
                  Я здесь · ±{livePos!.accuracy} м
                </span>
              </div>
            )}

            {livePos && !liveMapPos && pdfName && fixedCount >= 3 && (
              <div className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 z-30 flex items-center gap-1.5 rounded-full bg-accent/20 border border-accent/40 px-3 py-1.5 font-mono text-[11px] text-accent">
                <Icon name="Navigation" size={12} /> Позиция за пределами откалиброванной области
              </div>
            )}

            {/* Ghost new point */}
            {pending && (
              <div style={{ left: `${pending.px}%`, top: `${pending.py}%` }}
                className="pointer-events-none absolute z-30 -translate-x-1/2 -translate-y-1/2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-dashed border-accent bg-accent/20 animate-pulse">
                  <span className="h-2 w-2 rounded-full bg-accent" />
                </span>
              </div>
            )}

            {/* New point popup */}
            {pending && (
              <div data-point="true" onClick={e => e.stopPropagation()}
                style={{ left: `${Math.min(pending.px, 70)}%`, top: `${Math.min(pending.py + 4, 78)}%` }}
                className="absolute z-40 w-72 rounded-xl border border-primary/40 bg-card shadow-2xl animate-fade-in">
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

                  {/* Система координат в попапе */}
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Система координат</span>
                    <div className="flex items-center rounded-md border border-border bg-secondary p-0.5 font-mono text-[11px]">
                      {(['WGS84', 'MSK64'] as CoordSys[]).map(s => (
                        <button key={s} onClick={() => { setCoordSys(s); setInputA(''); setInputB(''); }}
                          className={`rounded px-2 py-0.5 transition-colors ${
                            coordSys === s ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
                          }`}>
                          {s === 'WGS84' ? 'WGS-84' : 'МСК-64'}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="mb-1 block font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{fieldLabels.a}</label>
                      <input value={inputA} onChange={e => setInputA(e.target.value)}
                        className="w-full rounded-md border border-border bg-secondary px-3 py-1.5 font-mono text-sm text-foreground outline-none focus:border-primary"
                        placeholder={fieldLabels.pa} />
                    </div>
                    <div>
                      <label className="mb-1 block font-mono text-[10px] uppercase tracking-widest text-muted-foreground">{fieldLabels.b}</label>
                      <input value={inputB} onChange={e => setInputB(e.target.value)}
                        className="w-full rounded-md border border-border bg-secondary px-3 py-1.5 font-mono text-sm text-foreground outline-none focus:border-primary"
                        placeholder={fieldLabels.pb} />
                    </div>
                  </div>

                  {/* Перекрёстный пересчёт — превью */}
                  {inputA && inputB && (() => {
                    const a = parseFloat(inputA), b = parseFloat(inputB);
                    if (isNaN(a) || isNaN(b)) return null;
                    try {
                      if (coordSys === 'WGS84') {
                        const m = wgsToMsk64(a, b);
                        return (
                          <div className="rounded-md bg-secondary px-3 py-2 font-mono text-[11px] text-muted-foreground">
                            <span className="text-primary">МСК-1964:</span> X {m.X.toFixed(2)} · Y {m.Y.toFixed(2)} м
                          </div>
                        );
                      } else {
                        const w = msk64ToWgs(a, b);
                        return (
                          <div className="rounded-md bg-secondary px-3 py-2 font-mono text-[11px] text-muted-foreground">
                            <span className="text-primary">WGS-84:</span> φ {w.lat.toFixed(6)}° λ {w.lon.toFixed(6)}°
                          </div>
                        );
                      }
                    } catch { return null; }
                  })()}

                  <button type="button" onClick={captureGnss} disabled={gnssLoading}
                    className="flex w-full items-center justify-center gap-2 rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-sm font-medium text-accent hover:bg-accent/20 disabled:opacity-60 transition-colors">
                    {gnssLoading
                      ? <><Icon name="LoaderCircle" size={15} className="animate-spin" /> Определяю…</>
                      : <><Icon name="Satellite" size={15} /> Снять GNSS ({coordSys === 'WGS84' ? 'WGS-84' : 'МСК-1964'})</>}
                  </button>

                  {gnssAccuracy !== null && (
                    <div className="flex items-center gap-2 rounded-md bg-primary/10 px-2.5 py-2 font-mono text-[11px] text-primary">
                      <Icon name="CircleCheck" size={13} className="shrink-0" /> Точность ±{gnssAccuracy} м
                    </div>
                  )}
                  {gnssError && (
                    <div className="flex items-center gap-2 rounded-md bg-destructive/10 px-2.5 py-2 text-[11px] text-destructive-foreground">
                      <Icon name="TriangleAlert" size={13} className="shrink-0 text-destructive" /> {gnssError}
                    </div>
                  )}

                  <div className="flex gap-2">
                    <button onClick={cancelPoint} className="flex-1 rounded-md border border-border py-2 text-sm text-muted-foreground hover:bg-secondary">Отмена</button>
                    <button onClick={confirmPoint} className="flex-1 rounded-md bg-primary py-2 text-sm font-medium text-primary-foreground hover:opacity-90">Добавить</button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Page nav */}
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

          {(error || trackError) && (
            <div className="absolute bottom-14 left-1/2 z-20 -translate-x-1/2 flex items-center gap-2 rounded-md border border-destructive bg-destructive/15 px-3 py-2 text-xs text-destructive-foreground">
              <Icon name="TriangleAlert" size={14} /> {error || trackError}
            </div>
          )}

          {activeTool === 'point' && pdfName && !pending && (
            <div className="pointer-events-none absolute bottom-4 left-1/2 z-20 -translate-x-1/2 flex items-center gap-2 rounded-full border border-border bg-card/80 px-3 py-1.5 font-mono text-xs text-muted-foreground backdrop-blur">
              <Icon name="MousePointer2" size={13} className="text-primary" />
              Кликните на карту для добавления точки
            </div>
          )}

          {/* Coords HUD */}
          <div className="absolute bottom-4 left-4 z-20 flex items-center gap-3 rounded-md border border-border bg-card/80 px-3 py-2 font-mono text-xs backdrop-blur">
            {livePos ? (() => {
              const f = formatLive(livePos, coordSys);
              return <>
                <span className="text-muted-foreground">{f.la} <span className="text-primary">{f.a}</span></span>
                <span className="text-muted-foreground">{f.lb} <span className="text-primary">{f.b}</span></span>
                <span className="flex items-center gap-1 text-accent">
                  <span className="h-1.5 w-1.5 rounded-full bg-accent animate-pulse" /> live ±{livePos.accuracy} м
                </span>
              </>;
            })() : (
              <span className="text-muted-foreground">
                {coordSys === 'WGS84' ? 'WGS-84' : 'МСК-1964 СПб'} · GNSS выкл
              </span>
            )}
          </div>
        </main>

        {/* ── Right panel ── */}
        <aside className="flex w-80 shrink-0 flex-col border-l border-border">

          {/* Live position */}
          <section className="border-b border-border p-5">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <Icon name="Navigation" size={16} className={tracking ? 'text-accent' : 'text-muted-foreground'} />
                Моё положение
              </h2>
              <button onClick={tracking ? stopTracking : startTracking}
                className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-all ${
                  tracking ? 'bg-destructive/20 text-destructive hover:bg-destructive/30' : 'bg-accent/15 text-accent hover:bg-accent/25'
                }`}>
                <span className={`h-1.5 w-1.5 rounded-full ${tracking ? 'bg-destructive animate-pulse' : 'bg-accent'}`} />
                {tracking ? 'Остановить' : 'Включить'}
              </button>
            </div>

            {livePos ? (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  {coordSys === 'WGS84' ? (
                    <>
                      <div className="rounded-lg border border-border bg-secondary/50 p-2.5">
                        <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Широта φ</div>
                        <div className="font-mono text-sm font-semibold text-foreground">{livePos.lat.toFixed(7)}</div>
                      </div>
                      <div className="rounded-lg border border-border bg-secondary/50 p-2.5">
                        <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Долгота λ</div>
                        <div className="font-mono text-sm font-semibold text-foreground">{livePos.lon.toFixed(7)}</div>
                      </div>
                    </>
                  ) : (() => {
                    const m = wgsToMsk64(livePos.lat, livePos.lon);
                    return (
                      <>
                        <div className="rounded-lg border border-border bg-secondary/50 p-2.5">
                          <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">X (север)</div>
                          <div className="font-mono text-sm font-semibold text-foreground">{m.X.toFixed(2)} м</div>
                        </div>
                        <div className="rounded-lg border border-border bg-secondary/50 p-2.5">
                          <div className="mb-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Y (восток)</div>
                          <div className="font-mono text-sm font-semibold text-foreground">{m.Y.toFixed(2)} м</div>
                        </div>
                      </>
                    );
                  })()}
                </div>
                {/* Cross-system display */}
                {coordSys === 'WGS84' ? (() => {
                  const m = wgsToMsk64(livePos.lat, livePos.lon);
                  return (
                    <div className="rounded-md bg-secondary px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
                      МСК-1964: X {m.X.toFixed(1)} · Y {m.Y.toFixed(1)} м
                    </div>
                  );
                })() : (
                  <div className="rounded-md bg-secondary px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
                    WGS-84: φ {livePos.lat.toFixed(5)}° · λ {livePos.lon.toFixed(5)}°
                  </div>
                )}
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
                    Добавьте 3+ привязанных точки для показа на карте
                  </div>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2 rounded-md bg-secondary px-3 py-2.5 text-xs text-muted-foreground">
                <Icon name="Info" size={14} className="shrink-0 text-accent" />
                {trackError ?? 'Нажмите «Включить» для отслеживания позиции на карте'}
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
              <span className="font-mono text-xs text-muted-foreground">{fixedCount}/{Math.max(points.length, 4)}</span>
            </div>
            <div className="mb-3 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.min((fixedCount / 4) * 100, 100)}%` }} />
            </div>
            <div className="flex items-center gap-2 rounded-md bg-secondary px-3 py-2 text-xs text-muted-foreground">
              <Icon name="Info" size={14} className="shrink-0 text-accent" />
              {fixedCount >= 3 ? 'Аффинная калибровка активна.' : `Нужно ещё ${3 - fixedCount} точек.`}
            </div>
          </section>

          {/* Control points list */}
          <section className="flex-1 overflow-y-auto p-5">
            <h3 className="mb-3 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              Контрольные точки ({points.length})
            </h3>
            <div className="space-y-2">
              {points.map(p => {
                const c = formatCoord(p.lat, p.lon, coordSys);
                return (
                  <div key={p.id} onClick={() => setSelectedPoint(selectedPoint === p.id ? null : p.id)}
                    className={`group relative w-full cursor-pointer rounded-lg border p-3 transition-colors ${
                      selectedPoint === p.id ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground/40'
                    }`}>
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
                        <button onClick={e => { e.stopPropagation(); deletePoint(p.id); }}
                          className="hidden rounded p-0.5 text-muted-foreground hover:bg-destructive/20 hover:text-destructive group-hover:block">
                          <Icon name="Trash2" size={13} />
                        </button>
                      </div>
                    </div>
                    <div className="space-y-0.5 font-mono text-[11px] text-muted-foreground">
                      <div>{c.line1}</div>
                      <div>{c.line2}</div>
                    </div>
                  </div>
                );
              })}
            </div>

            <button onClick={() => setActiveTool('point')}
              className={`mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-dashed py-2.5 text-xs transition-colors ${
                activeTool === 'point' ? 'border-primary bg-primary/5 text-primary' : 'border-border text-muted-foreground hover:border-primary hover:text-primary'
              }`}>
              <Icon name="Plus" size={14} />
              {activeTool === 'point' ? 'Кликните на карту…' : 'Добавить точку на карте'}
            </button>

            <button
              onClick={() => {
                if (!pdfName) return;
                const id = nextId++;
                setLabelInput(`КТ-0${id}`);
                setInputA(''); setInputB(''); setGnssAccuracy(null); setGnssError(null);
                setPending({ px: 50, py: 50 }); setActiveTool('point');
                setTimeout(() => captureGnss(), 100);
              }}
              disabled={!pdfName}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg border border-accent/40 bg-accent/10 py-2.5 text-xs font-medium text-accent hover:bg-accent/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              <Icon name="Satellite" size={14} />
              Снять точку через GNSS
            </button>
          </section>

          {/* Measurements */}
          <section className="border-t border-border p-5">
            <h3 className="mb-3 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              Система · {coordSys === 'WGS84' ? 'WGS-84' : `МСК-1964 (lon₀=${MSK64_PARAMS.lon0}°)`}
            </h3>
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
