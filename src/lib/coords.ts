/**
 * Координатные преобразования: WGS-84 ↔ СК-42 (Красовского) ↔ МСК-1964 СПб
 *
 * Параметры МСК-1964 Санкт-Петербург (зона 1):
 *   Эллипсоид: Красовского (a=6378245, 1/f=298.3)
 *   Проекция: Поперечная Меркатора (Гаусс-Крюгер)
 *   Осевой меридиан: 30° в.д.
 *   Начало координат X: 95948.85 м (смещение на север)
 *   Начало координат Y: -6552807.1 м (смещение на восток, номер зоны не добавляется)
 *   Масштаб: 1.0000000
 *
 * Параметры 7-параметрического перехода WGS-84 → СК-42 (Пулково 1942):
 *   По ГОСТ Р 51794-2008 и Приказу Росреестра:
 *   dX = +23.57 м, dY = −140.95 м, dZ = −79.80 м
 *   Rx = 0.0000 '', Ry = −0.3500 '', Rz = −0.7900 ''
 *   m  = −0.2200 ppm
 */

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;

// ── Эллипсоид Красовского ──────────────────────────────────────────────────
const KR = {
  a: 6378245.0,
  b: 6356863.0188,
  f: 1 / 298.3,
  e2: 0.006694379990141,   // e² = 2f − f²
};
KR.e2 = 2 * KR.f - KR.f * KR.f;

// ── Эллипсоид WGS-84 ──────────────────────────────────────────────────────
const WGS = {
  a: 6378137.0,
  b: 6356752.3142,
  f: 1 / 298.257223563,
  e2: 0.00669437999014,
};

// ── 7 параметров: WGS-84 → СК-42 (Хельмерт, знак перехода X→Y→Z) ─────────
const WGS_TO_SK42 = {
  dX: -23.57,   // м  (обратный знак: от WGS к СК-42)
  dY: +140.95,
  dZ: +79.80,
  Rx: -0.0000 * DEG / 3600,  // рад
  Ry: +0.3500 * DEG / 3600,
  Rz: +0.7900 * DEG / 3600,
  m:  +0.2200e-6,             // ppm
};

// ── WGS-84 геодезические → ECEF ───────────────────────────────────────────
function wgsToEcef(lat: number, lon: number, h = 0) {
  const f = lat * DEG, l = lon * DEG;
  const N = WGS.a / Math.sqrt(1 - WGS.e2 * Math.sin(f) ** 2);
  return {
    X: (N + h) * Math.cos(f) * Math.cos(l),
    Y: (N + h) * Math.cos(f) * Math.sin(l),
    Z: (N * (1 - WGS.e2) + h) * Math.sin(f),
  };
}

// ── Хельмерт 7-параметров ECEF→ECEF ──────────────────────────────────────
function helmert(X: number, Y: number, Z: number, p: typeof WGS_TO_SK42) {
  const { dX, dY, dZ, Rx, Ry, Rz, m } = p;
  const s = 1 + m;
  return {
    X: dX + s * (X + Rz * Y - Ry * Z),
    Y: dY + s * (-Rz * X + Y + Rx * Z),
    Z: dZ + s * (Ry * X - Rx * Y + Z),
  };
}

// ── ECEF → геодезические (итерация Боурса) ───────────────────────────────
function ecefToGeo(X: number, Y: number, Z: number, ell: typeof KR) {
  const lon = Math.atan2(Y, X);
  const p = Math.sqrt(X * X + Y * Y);
  let lat = Math.atan2(Z, p * (1 - ell.e2));
  for (let i = 0; i < 10; i++) {
    const N = ell.a / Math.sqrt(1 - ell.e2 * Math.sin(lat) ** 2);
    lat = Math.atan2(Z + ell.e2 * N * Math.sin(lat), p);
  }
  return { lat: lat * RAD, lon: lon * RAD };
}

// ── Гаусс-Крюгер: СК-42 геодезические → плоские ─────────────────────────
function gkProject(lat: number, lon: number, lon0: number) {
  const a = KR.a, e2 = KR.e2;
  const f = lat * DEG, l = lon * DEG, l0 = lon0 * DEG;
  const dl = l - l0;

  const sinF = Math.sin(f), cosF = Math.cos(f), tanF = Math.tan(f);
  const N = a / Math.sqrt(1 - e2 * sinF * sinF);
  const t = tanF;
  const eta2 = (e2 / (1 - e2)) * cosF * cosF;

  // Меридиональная дуга
  const e4 = e2 * e2, e6 = e4 * e2;
  const A0 = 1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256;
  const A2 = 3 / 8 * (e2 + e4 / 4 + 15 * e6 / 128);
  const A4 = 15 / 256 * (e4 + 3 * e6 / 4);
  const A6 = 35 * e6 / 3072;
  const M = a * (A0 * f - A2 * Math.sin(2 * f) + A4 * Math.sin(4 * f) - A6 * Math.sin(6 * f));

  const x = M
    + (N / 2) * sinF * cosF * dl * dl
    + (N / 24) * sinF * cosF ** 3 * (5 - t * t + 9 * eta2 + 4 * eta2 * eta2) * dl ** 4
    + (N / 720) * sinF * cosF ** 5 * (61 - 58 * t * t + t ** 4) * dl ** 6;

  const y = N * cosF * dl
    + (N / 6) * cosF ** 3 * (1 - t * t + eta2) * dl ** 3
    + (N / 120) * cosF ** 5 * (5 - 18 * t * t + t ** 4 + 14 * eta2 - 58 * eta2 * t * t) * dl ** 5;

  return { x, y };
}

// ── Обратная Гаусс-Крюгер: плоские МСК-1964 → СК-42 геодезические ───────
function gkInverse(X: number, Y: number, lon0: number) {
  const a = KR.a, e2 = KR.e2;
  // Вычислим широту по меридиональной дуге (итерация)
  let fi = X / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64));
  for (let i = 0; i < 10; i++) {
    const e4 = e2 * e2, e6 = e4 * e2;
    const A0 = 1 - e2 / 4 - 3 * e4 / 64 - 5 * e6 / 256;
    const A2 = 3 / 8 * (e2 + e4 / 4 + 15 * e6 / 128);
    const A4 = 15 / 256 * (e4 + 3 * e6 / 4);
    const A6 = 35 * e6 / 3072;
    const M = a * (A0 * fi - A2 * Math.sin(2 * fi) + A4 * Math.sin(4 * fi) - A6 * Math.sin(6 * fi));
    const dM_dfi = a * (A0 - 2 * A2 * Math.cos(2 * fi) + 4 * A4 * Math.cos(4 * fi) - 6 * A6 * Math.cos(6 * fi));
    fi = fi - (M - X) / dM_dfi;
  }

  const sinFi = Math.sin(fi), cosFi = Math.cos(fi), tanFi = Math.tan(fi);
  const N = a / Math.sqrt(1 - e2 * sinFi * sinFi);
  const t = tanFi;
  const eta2 = (e2 / (1 - e2)) * cosFi * cosFi;
  const R = a * (1 - e2) / Math.pow(1 - e2 * sinFi * sinFi, 1.5);

  const lat = fi
    - (t * Y * Y) / (2 * R * N)
    + (t / (24 * R * N ** 3)) * (5 + 3 * t * t + eta2 - 9 * eta2 * t * t) * Y ** 4
    - (t / (720 * R * N ** 5)) * (61 + 90 * t * t + 45 * t ** 4) * Y ** 6;

  const lon = lon0 * DEG
    + Y / (N * cosFi)
    - Y ** 3 / (6 * N ** 3 * cosFi) * (1 + 2 * t * t + eta2)
    + Y ** 5 / (120 * N ** 5 * cosFi) * (5 + 28 * t * t + 24 * t ** 4 + 6 * eta2 + 8 * eta2 * t * t);

  return { lat: lat * RAD, lon: lon * RAD };
}

// ──────────────────────────────────────────────────────────────────────────
// МСК-1964 СПб параметры
// ──────────────────────────────────────────────────────────────────────────
export const MSK64_PARAMS = {
  lon0: 30.0,         // осевой меридиан
  x0: 95948.85,       // смещение N (Easting false)
  y0: -6552807.1,     // смещение E (Northing false, отрицательное)
  label: 'МСК-1964 СПб',
};

/** WGS-84 (°) → МСК-1964 СПб (X м, Y м) */
export function wgsToMsk64(lat: number, lon: number): { X: number; Y: number } {
  // 1. WGS-84 → ECEF
  const ecefWgs = wgsToEcef(lat, lon);
  // 2. ECEF WGS → ECEF СК-42 (Хельмерт)
  const ecefSk = helmert(ecefWgs.X, ecefWgs.Y, ecefWgs.Z, WGS_TO_SK42);
  // 3. ECEF → геодезические СК-42
  const geoSk = ecefToGeo(ecefSk.X, ecefSk.Y, ecefSk.Z, KR);
  // 4. Гаусс-Крюгер → плоские
  const gk = gkProject(geoSk.lat, geoSk.lon, MSK64_PARAMS.lon0);
  // 5. Применить смещение МСК-1964
  return {
    X: gk.x - MSK64_PARAMS.x0,
    Y: gk.y - MSK64_PARAMS.y0,
  };
}

/** МСК-1964 СПб (X м, Y м) → WGS-84 (lat °, lon °) */
export function msk64ToWgs(X: number, Y: number): { lat: number; lon: number } {
  // 1. Убрать смещение
  const x = X + MSK64_PARAMS.x0;
  const y = Y + MSK64_PARAMS.y0;
  // 2. Обратный Гаусс-Крюгер → СК-42 геодезические
  const geoSk = gkInverse(x, y, MSK64_PARAMS.lon0);
  // 3. Геодезические СК-42 → ECEF СК-42
  const sinF = Math.sin(geoSk.lat * DEG), cosF = Math.cos(geoSk.lat * DEG);
  const N = KR.a / Math.sqrt(1 - KR.e2 * sinF * sinF);
  const ecefSk = {
    X: N * cosF * Math.cos(geoSk.lon * DEG),
    Y: N * cosF * Math.sin(geoSk.lon * DEG),
    Z: N * (1 - KR.e2) * sinF,
  };
  // 4. Хельмерт обратный: СК-42 → WGS-84
  const p = {
    dX: -WGS_TO_SK42.dX, dY: -WGS_TO_SK42.dY, dZ: -WGS_TO_SK42.dZ,
    Rx: -WGS_TO_SK42.Rx, Ry: -WGS_TO_SK42.Ry, Rz: -WGS_TO_SK42.Rz,
    m: -WGS_TO_SK42.m,
  };
  const ecefWgs = helmert(ecefSk.X, ecefSk.Y, ecefSk.Z, p);
  // 5. ECEF → WGS-84 геодезические
  return ecefToGeo(ecefWgs.X, ecefWgs.Y, ecefWgs.Z, WGS);
}

// ──────────────────────────────────────────────────────────────────────────
// Форматирование
// ──────────────────────────────────────────────────────────────────────────

/** Градусы → ГГ°ММ'СС.ССС" */
export function toDms(deg: number, isLon = false): string {
  const abs = Math.abs(deg);
  const d = Math.floor(abs);
  const m = Math.floor((abs - d) * 60);
  const s = ((abs - d) * 60 - m) * 60;
  const hem = deg >= 0 ? (isLon ? 'E' : 'N') : (isLon ? 'W' : 'S');
  return `${d}°${String(m).padStart(2, '0')}'${s.toFixed(3).padStart(6, '0')}" ${hem}`;
}

/** Форматировать МСК-1964 в метрах */
export function formatMsk(X: number, Y: number): string {
  return `X=${X.toFixed(2)} Y=${Y.toFixed(2)}`;
}
