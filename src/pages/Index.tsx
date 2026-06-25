import { useState, useRef, useCallback } from 'react';
import Icon from '@/components/ui/icon';
import * as pdfjsLib from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

interface ControlPoint {
  id: number;
  label: string;
  px: number; // % from map frame
  py: number;
  lat: string;
  lon: string;
  status: 'fixed' | 'pending';
}

interface PendingPoint {
  px: number;
  py: number;
}

const tools = [
  { id: 'select', icon: 'MousePointer2', label: 'Выбор' },
  { id: 'point', icon: 'MapPin', label: 'Контр. точка' },
  { id: 'distance', icon: 'Ruler', label: 'Расстояние' },
  { id: 'area', icon: 'Hexagon', label: 'Площадь' },
  { id: 'gnss', icon: 'Satellite', label: 'GNSS' },
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

  // PDF state
  const [pdfName, setPdfName] = useState<string | null>(null);
  const [pdfPages, setPdfPages] = useState(0);
  const [pageNum, setPageNum] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // New point popup
  const [pending, setPending] = useState<PendingPoint | null>(null);
  const [latInput, setLatInput] = useState('');
  const [lonInput, setLonInput] = useState('');
  const [labelInput, setLabelInput] = useState('');

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mapFrameRef = useRef<HTMLDivElement>(null);
  const pdfDocRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);

  const fixedCount = points.filter((p) => p.status === 'fixed').length;

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
    setError(null);
    setLoading(true);
    try {
      const buffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
      pdfDocRef.current = pdf;
      setPdfName(file.name);
      setPdfPages(pdf.numPages);
      setPageNum(1);
      await renderPage(1);
    } catch { setError('Не удалось открыть PDF'); }
    finally { setLoading(false); }
  };

  const changePage = async (dir: number) => {
    const next = pageNum + dir;
    if (next < 1 || next > pdfPages) return;
    setPageNum(next);
    await renderPage(next);
  };

  /* ── Click on map ── */
  const handleMapClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (activeTool !== 'point') return;
    if (!pdfName) return;
    const frame = mapFrameRef.current;
    if (!frame) return;
    // Skip if click landed on an existing point button
    if ((e.target as HTMLElement).closest('[data-point]')) return;
    const rect = frame.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * 100;
    const py = ((e.clientY - rect.top) / rect.height) * 100;
    const id = nextId++;
    setLabelInput(`КТ-0${id}`);
    setLatInput('');
    setLonInput('');
    setPending({ px, py });
    setSelectedPoint(null);
  }, [activeTool, pdfName]);

  const confirmPoint = () => {
    if (!pending) return;
    const id = nextId - 1; // was incremented at click
    setPoints((prev) => [
      ...prev,
      {
        id,
        label: labelInput || `КТ-0${id}`,
        px: pending.px,
        py: pending.py,
        lat: latInput || '—',
        lon: lonInput || '—',
        status: latInput ? 'fixed' : 'pending',
      },
    ]);
    setSelectedPoint(id);
    setPending(null);
  };

  const cancelPoint = () => {
    nextId--;
    setPending(null);
  };

  const deletePoint = (id: number) => {
    setPoints((prev) => prev.filter((p) => p.id !== id));
    if (selectedPoint === id) setSelectedPoint(null);
  };

  const cursorClass =
    activeTool === 'point' && pdfName ? 'cursor-crosshair' : 'cursor-default';

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      <input ref={fileInputRef} type="file" accept="application/pdf" className="hidden" onChange={handleFile} />

      {/* Top bar */}
      <header className="flex items-center justify-between border-b border-border px-5 h-14 shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Icon name="Compass" size={18} />
          </div>
          <div className="leading-tight">
            <div className="font-semibold tracking-tight">GeoCalibrate</div>
            <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">field survey toolkit</div>
          </div>
        </div>

        <div className="hidden items-center gap-2 rounded-full border border-border bg-card px-3 py-1.5 md:flex">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping-slow rounded-full bg-primary" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
          </span>
          <span className="font-mono text-xs text-muted-foreground">
            GNSS · <span className="text-primary">12 спутников</span> · ±0.8 м
          </span>
        </div>

        <button
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-2 rounded-md bg-primary px-3.5 py-1.5 text-sm font-medium text-primary-foreground transition-transform hover:scale-[1.03]"
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
              className={`group relative flex h-12 w-12 flex-col items-center justify-center rounded-lg transition-colors ${
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

          {/* map frame — click target */}
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

            {/* existing control points */}
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

                {/* label always visible */}
                <span className="pointer-events-none absolute left-7 top-1/2 -translate-y-1/2 whitespace-nowrap rounded bg-card/90 px-1.5 py-0.5 font-mono text-[10px] text-foreground">
                  {p.label}
                </span>

                {/* delete button on hover */}
                <button
                  data-point="true"
                  onClick={(e) => { e.stopPropagation(); deletePoint(p.id); }}
                  className="absolute -right-2 -top-2 hidden h-4 w-4 items-center justify-center rounded-full bg-destructive text-white group-hover:flex"
                >
                  <Icon name="X" size={10} />
                </button>
              </div>
            ))}

            {/* ghost point while popup open */}
            {pending && (
              <div
                style={{ left: `${pending.px}%`, top: `${pending.py}%` }}
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
                style={{
                  left: `${Math.min(pending.px, 72)}%`,
                  top: `${Math.min(pending.py + 4, 80)}%`,
                }}
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
                    <label className="mb-1 block font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                      Название
                    </label>
                    <input
                      autoFocus
                      value={labelInput}
                      onChange={(e) => setLabelInput(e.target.value)}
                      className="w-full rounded-md border border-border bg-secondary px-3 py-1.5 font-mono text-sm text-foreground outline-none focus:border-primary"
                      placeholder="КТ-05"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="mb-1 block font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                        Широта (lat)
                      </label>
                      <input
                        value={latInput}
                        onChange={(e) => setLatInput(e.target.value)}
                        className="w-full rounded-md border border-border bg-secondary px-3 py-1.5 font-mono text-sm text-foreground outline-none focus:border-primary"
                        placeholder="55.7512"
                      />
                    </div>
                    <div>
                      <label className="mb-1 block font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                        Долгота (lon)
                      </label>
                      <input
                        value={lonInput}
                        onChange={(e) => setLonInput(e.target.value)}
                        className="w-full rounded-md border border-border bg-secondary px-3 py-1.5 font-mono text-sm text-foreground outline-none focus:border-primary"
                        placeholder="37.6184"
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-2 rounded-md bg-secondary px-2.5 py-2 text-[11px] text-muted-foreground">
                    <Icon name="Satellite" size={12} className="text-accent shrink-0" />
                    Или нажмите «Снять GNSS» — координаты определятся автоматически
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={cancelPoint}
                      className="flex-1 rounded-md border border-border py-2 text-sm text-muted-foreground hover:bg-secondary"
                    >
                      Отмена
                    </button>
                    <button
                      onClick={confirmPoint}
                      className="flex-1 rounded-md bg-primary py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
                    >
                      Добавить
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* page navigation */}
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
            <div className="absolute bottom-4 left-1/2 z-20 -translate-x-1/2 flex items-center gap-2 rounded-md border border-destructive bg-destructive/15 px-3 py-2 text-xs text-destructive-foreground">
              <Icon name="TriangleAlert" size={14} /> {error}
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
            <span className="text-muted-foreground">N <span className="text-primary">55.750118</span></span>
            <span className="text-muted-foreground">E <span className="text-primary">37.618901</span></span>
            <span className="text-muted-foreground">M 1:2000</span>
          </div>
        </main>

        {/* Right panel */}
        <aside className="flex w-80 shrink-0 flex-col border-l border-border">
          <section className="border-b border-border p-5 animate-fade-in">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <Icon name="Target" size={16} className="text-primary" />
                Калибровка карты
              </h2>
              <span className="font-mono text-xs text-muted-foreground">{fixedCount}/{Math.max(points.length, 4)} точки</span>
            </div>
            <div className="mb-3 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${Math.min((fixedCount / 4) * 100, 100)}%` }}
              />
            </div>
            <div className="flex items-center gap-2 rounded-md bg-secondary px-3 py-2 text-xs text-muted-foreground">
              <Icon name="Info" size={14} className="shrink-0 text-accent" />
              {fixedCount >= 4
                ? 'Калибровка готова. Аффинное преобразование активно.'
                : `Нужно ещё ${4 - fixedCount} точек для аффинного преобразования.`}
            </div>
          </section>

          <section className="flex-1 overflow-y-auto p-5">
            <h3 className="mb-3 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              Контрольные точки ({points.length})
            </h3>
            <div className="space-y-2">
              {points.map((p) => (
                <div
                  key={p.id}
                  onClick={() => setSelectedPoint(selectedPoint === p.id ? null : p.id)}
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
                      <button
                        onClick={(e) => { e.stopPropagation(); deletePoint(p.id); }}
                        className="hidden rounded p-0.5 text-muted-foreground hover:bg-destructive/20 hover:text-destructive group-hover:block"
                      >
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

            <button
              onClick={() => setActiveTool('point')}
              className={`mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-dashed py-2.5 text-xs transition-colors ${
                activeTool === 'point'
                  ? 'border-primary bg-primary/5 text-primary'
                  : 'border-border text-muted-foreground hover:border-primary hover:text-primary'
              }`}
            >
              <Icon name="Plus" size={14} />
              {activeTool === 'point' ? 'Кликните на карту…' : 'Добавить точку на карте'}
            </button>
          </section>

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
