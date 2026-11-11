const WIDTH = 1080;
const HEIGHT = 1920;

const defaults = {
  mode: 'required',
  safeArea: { top: 120, right: 96, bottom: 160, left: 96 },
  minFontPx: { headline: 54, body: 32, card: 32, brand: 28 },
  charsPerSecond: 12,
  minSceneSeconds: 1.2,
  overlapTolerancePx: 4,
};

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  return value;
}

function fields(value, names, label) {
  for (const key of Object.keys(value)) if (!names.includes(key)) throw new Error(`Unknown ${label} field: ${key}`);
}

function number(value, min, max, label) {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be a finite number between ${min} and ${max}.`);
  return value;
}

function normalizeVisualReview(value = {}) {
  object(value, 'visualReview');
  fields(value, Object.keys(defaults), 'visualReview');
  const mode = value.mode ?? defaults.mode;
  if (!['required', 'off'].includes(mode)) throw new Error('visualReview.mode must be required or off.');
  const suppliedSafe = object(value.safeArea ?? {}, 'visualReview.safeArea');
  fields(suppliedSafe, Object.keys(defaults.safeArea), 'visualReview.safeArea');
  const safeArea = { ...defaults.safeArea, ...suppliedSafe };
  for (const key of ['top', 'bottom']) number(safeArea[key], 0, HEIGHT - 1, `safeArea.${key}`);
  for (const key of ['left', 'right']) number(safeArea[key], 0, WIDTH - 1, `safeArea.${key}`);
  if (safeArea.left + safeArea.right >= WIDTH || safeArea.top + safeArea.bottom >= HEIGHT) throw new Error('visualReview safe area must have positive width and height.');
  const suppliedFont = object(value.minFontPx ?? {}, 'visualReview.minFontPx');
  fields(suppliedFont, Object.keys(defaults.minFontPx), 'visualReview.minFontPx');
  const minFontPx = { ...defaults.minFontPx, ...suppliedFont };
  for (const key of Object.keys(minFontPx)) number(minFontPx[key], 1, 200, `minFontPx.${key}`);
  return { mode, safeArea, minFontPx,
    charsPerSecond: number(value.charsPerSecond ?? defaults.charsPerSecond, 1, 100, 'charsPerSecond'),
    minSceneSeconds: number(value.minSceneSeconds ?? defaults.minSceneSeconds, .1, 90, 'minSceneSeconds'),
    overlapTolerancePx: number(value.overlapTolerancePx ?? defaults.overlapTolerancePx, 0, 64, 'overlapTolerancePx'),
  };
}

module.exports = { normalizeVisualReview, WIDTH, HEIGHT };
