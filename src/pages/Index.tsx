import { useState } from 'react';
import Icon from '@/components/ui/icon';

interface ControlPoint {
  id: number;
  label: string;
  px: number;
  py: number;
  lat: string;
  lon: string;
  status: 'fixed' | 'pending';
}

const controlPoints: ControlPoint[] = [
  { id: 1, label: 'КТ-01', px: 18, py: 22, lat: '55.751244', lon: '37.618423', status: 'fixed' },
  { id: 2, label: 'КТ-02', px: 78, py: 28, lat: '55.752981', lon: '37.621702', status: 'fixed' },
  { id: 3, label: 'КТ-03', px: 30, py: 74, lat: '55.749103', lon: '37.616890', status: 'fixed' },
  { id: 4, label: 'КТ-04', px: 70, py: 80, lat: '—', lon: '—', status: 'pending' },
];

const tools = [
  { id: 'select', icon: 'MousePointer2', label: 'Выбор' },
  { id: 'point', icon: 'MapPin', label: 'Контр. точка' },
  { id: 'distance', icon: 'Ruler', label: 'Расстояние' },
  { id: 'area', icon: 'Hexagon', label: 'Площадь' },
  { id: 'gnss', icon: 'Satellite', label: 'GNSS' },
];

const Index = () => {
  const [activeTool, setActiveTool] = useState('point');
  const [selectedPoint, setSelectedPoint] = useState<number>(3);

  const fixedCount = controlPoints.filter((p) => p.status === 'fixed').length;

  return (
    <div className="min-h-screen flex flex-col bg-background text-foreground">
      {/* Top bar */}
      <header className="flex items-center justify-between border-b border-border px-5 h-14 shrink-0">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <Icon name="Compass" size={18} />
          </div>
          <div className="leading-tight">
            <div className="font-semibold tracking-tight">GeoCalibrate</div>
            <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              field survey toolkit
            </div>
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

        <button className="flex items-center gap-2 rounded-md bg-primary px-3.5 py-1.5 text-sm font-medium text-primary-foreground transition-transform hover:scale-[1.03]">
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
              onClick={() => setActiveTool(t.id)}
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
        <main className="relative flex-1 overflow-hidden grid-blueprint-fine">
          {/* scan line */}
          <div className="pointer-events-none absolute inset-x-0 top-0 h-px animate-scan bg-primary/40 shadow-[0_0_12px_2px_hsl(var(--primary)/0.5)]" />

          {/* PDF map mock frame */}
          <div className="absolute inset-8 rounded-lg border border-dashed border-primary/30">
            <div className="absolute left-3 top-3 rounded bg-card/80 px-2 py-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground backdrop-blur">
              план_участка_2026.pdf
            </div>

            {/* contour mock */}
            <svg className="absolute inset-0 h-full w-full" preserveAspectRatio="none">
              <polygon
                points="18%,30% 55%,18% 85%,40% 72%,82% 30%,76%"
                fill="hsl(var(--primary) / 0.05)"
                stroke="hsl(var(--primary) / 0.5)"
                strokeWidth="1.5"
                strokeDasharray="6 4"
              />
            </svg>

            {/* control points */}
            {controlPoints.map((p) => (
              <button
                key={p.id}
                onClick={() => setSelectedPoint(p.id)}
                style={{ left: `${p.px}%`, top: `${p.py}%` }}
                className="group absolute -translate-x-1/2 -translate-y-1/2"
              >
                <span
                  className={`relative flex h-5 w-5 items-center justify-center rounded-full border-2 transition-transform group-hover:scale-125 ${
                    p.status === 'fixed'
                      ? 'border-primary bg-primary/20'
                      : 'border-accent bg-accent/20 animate-pulse'
                  } ${selectedPoint === p.id ? 'scale-125' : ''}`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      p.status === 'fixed' ? 'bg-primary' : 'bg-accent'
                    }`}
                  />
                </span>
                <span className="absolute left-6 top-1/2 -translate-y-1/2 whitespace-nowrap rounded bg-card px-1.5 py-0.5 font-mono text-[10px] text-foreground opacity-0 transition-opacity group-hover:opacity-100">
                  {p.label}
                </span>
              </button>
            ))}

            {/* crosshair */}
            <div className="pointer-events-none absolute right-6 bottom-6 flex h-16 w-16 items-center justify-center">
              <Icon name="Crosshair" size={56} className="text-primary/25" />
            </div>
          </div>

          {/* coords HUD */}
          <div className="absolute bottom-4 left-4 flex items-center gap-4 rounded-md border border-border bg-card/80 px-3 py-2 font-mono text-xs backdrop-blur">
            <span className="text-muted-foreground">
              N <span className="text-primary">55.750118</span>
            </span>
            <span className="text-muted-foreground">
              E <span className="text-primary">37.618901</span>
            </span>
            <span className="text-muted-foreground">M 1:2000</span>
          </div>
        </main>

        {/* Right panel */}
        <aside className="flex w-80 shrink-0 flex-col border-l border-border">
          {/* Calibration status */}
          <section className="border-b border-border p-5 animate-fade-in">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <Icon name="Target" size={16} className="text-primary" />
                Калибровка карты
              </h2>
              <span className="font-mono text-xs text-muted-foreground">
                {fixedCount}/4 точки
              </span>
            </div>
            <div className="mb-3 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full bg-primary transition-all"
                style={{ width: `${(fixedCount / 4) * 100}%` }}
              />
            </div>
            <div className="flex items-center gap-2 rounded-md bg-secondary px-3 py-2 text-xs text-muted-foreground">
              <Icon name="Info" size={14} className="shrink-0 text-accent" />
              Привяжите минимум 4 контрольные точки для точного аффинного преобразования.
            </div>
          </section>

          {/* Control points list */}
          <section className="flex-1 overflow-y-auto p-5">
            <h3 className="mb-3 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              Контрольные точки
            </h3>
            <div className="space-y-2">
              {controlPoints.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setSelectedPoint(p.id)}
                  className={`w-full rounded-lg border p-3 text-left transition-colors ${
                    selectedPoint === p.id
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:border-muted-foreground/40'
                  }`}
                >
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="flex items-center gap-2 text-sm font-medium">
                      <Icon name="MapPin" size={14} className={p.status === 'fixed' ? 'text-primary' : 'text-accent'} />
                      {p.label}
                    </span>
                    <span
                      className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${
                        p.status === 'fixed'
                          ? 'bg-primary/15 text-primary'
                          : 'bg-accent/15 text-accent'
                      }`}
                    >
                      {p.status === 'fixed' ? 'привязана' : 'GNSS-фикс'}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-1 font-mono text-[11px] text-muted-foreground">
                    <span>lat {p.lat}</span>
                    <span>lon {p.lon}</span>
                  </div>
                </button>
              ))}
            </div>

            <button className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border py-2.5 text-xs text-muted-foreground transition-colors hover:border-primary hover:text-primary">
              <Icon name="Plus" size={14} />
              Снять точку через GNSS
            </button>
          </section>

          {/* Measurements */}
          <section className="border-t border-border p-5">
            <h3 className="mb-3 font-mono text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
              Измерения
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
