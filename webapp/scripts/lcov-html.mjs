#!/usr/bin/env node
/**
 * Convierte el `lcov.info` que produce `node --test --experimental-test-coverage`
 * en un informe HTML estático, sin dependencias externas.
 *
 * Uso:
 *   node scripts/lcov-html.mjs <lcov.info> <salida-html> [--root <dir>] [--title <texto>]
 *
 * `--root` es la carpeta contra la que se resuelven las rutas `SF:` para leer el
 * código fuente (por omisión, el directorio actual). Si un archivo no se puede
 * leer, su página muestra solo los datos de cobertura en lugar de fallar.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_TITLE = 'Cobertura de tests';

/** Normaliza separadores para que el informe sea igual en Windows y en Linux. */
function normalizePath(file) {
  return file.replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^\.\//, '');
}

/**
 * Lee un `lcov.info`. Cada bloque `SF:…end_of_record` es un archivo; aquí solo
 * se usan las líneas (`DA`), las ramas (`BRDA`) y las funciones (`FN`/`FNDA`).
 */
function parseLcov(text) {
  const records = new Map();
  let current = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('TN:')) continue;

    if (line.startsWith('SF:')) {
      const file = normalizePath(line.slice(3).trim());
      current = {
        file,
        lines: new Map(),
        branches: [],
        functions: new Map(),
        // Contadores que emite el propio runner: mandan sobre lo derivado de
        // DA/BRDA/FNDA, que puede colapsar funciones homónimas.
        lf: null,
        lh: null,
        brf: null,
        brh: null,
        fnf: null,
        fnh: null,
      };
      records.set(file, current);
      continue;
    }
    if (line === 'end_of_record') {
      current = null;
      continue;
    }
    if (current === null) continue;

    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon);
    const value = line.slice(colon + 1);

    if (field === 'DA') {
      const [lineNumber, hits] = value.split(',');
      current.lines.set(Number(lineNumber), Number(hits ?? 0));
    } else if (field === 'BRDA') {
      const [, , , taken] = value.split(',');
      // `-` significa que la rama nunca se evaluó: cuenta como no cubierta.
      current.branches.push(taken === '-' ? 0 : Number(taken));
    } else if (field === 'FNDA') {
      const comma = value.indexOf(',');
      const hits = Number(value.slice(0, comma));
      const name = value.slice(comma + 1);
      current.functions.set(name, (current.functions.get(name) ?? 0) + hits);
    } else if (
      field === 'LF' ||
      field === 'LH' ||
      field === 'BRF' ||
      field === 'BRH' ||
      field === 'FNF' ||
      field === 'FNH'
    ) {
      current[field.toLowerCase()] = Number(value);
    }
  }

  return [...records.values()]
    .filter((record) => record.lines.size > 0 || record.functions.size > 0)
    .sort((a, b) => a.file.localeCompare(b.file, 'en'));
}

function summarize(record) {
  const lines = [...record.lines.values()];
  const functions = [...record.functions.values()];
  return {
    lines: {
      hit: record.lh ?? lines.filter((hits) => hits > 0).length,
      total: record.lf ?? lines.length,
    },
    branches: {
      hit: record.brh ?? record.branches.filter((hits) => hits > 0).length,
      total: record.brf ?? record.branches.length,
    },
    functions: {
      hit: record.fnh ?? functions.filter((hits) => hits > 0).length,
      total: record.fnf ?? functions.length,
    },
  };
}

function addTotals(totals, summary) {
  for (const key of ['lines', 'branches', 'functions']) {
    totals[key].hit += summary[key].hit;
    totals[key].total += summary[key].total;
  }
}

/** `null` cuando no hay nada medido: mejor «—» que un 100 % inventado. */
function percent({ hit, total }) {
  return total === 0 ? null : (hit * 100) / total;
}

function level(value) {
  if (value === null) return 'none';
  if (value >= 80) return 'high';
  if (value >= 50) return 'mid';
  return 'low';
}

function formatPercent(value) {
  return value === null ? '—' : `${value.toFixed(2)} %`;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Líneas sin cubrir en formato `3-5 9`, como el resumen del test runner. */
function uncoveredRanges(record) {
  const uncovered = [...record.lines.entries()]
    .filter(([, hits]) => hits === 0)
    .map(([lineNumber]) => lineNumber)
    .sort((a, b) => a - b);

  const ranges = [];
  for (const lineNumber of uncovered) {
    const last = ranges[ranges.length - 1];
    if (last && lineNumber === last.end + 1) last.end = lineNumber;
    else ranges.push({ start: lineNumber, end: lineNumber });
  }
  return ranges
    .map(({ start, end }) => (start === end ? `${start}` : `${start}-${end}`))
    .join(' ');
}

function slugFor(file, index) {
  const base = file.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'archivo';
  return `${String(index + 1).padStart(3, '0')}-${base}.html`;
}

function statCell({ hit, total }) {
  const value = percent({ hit, total });
  return (
    `<td class="stat ${level(value)}"><span class="value">${formatPercent(value)}</span>` +
    `<span class="ratio">${hit}/${total}</span></td>`
  );
}

const STYLES = `:root {
  color-scheme: light dark;
  --bg: #f6f7f9;
  --panel: #ffffff;
  --ink: #1c2126;
  --muted: #5d6b76;
  --line: #d7dde3;
  --high: #177245;
  --mid: #8a6100;
  --low: #a32b2b;
  --uncovered: #fbe9e9;
  --covered: #eef7f1;
  --accent: #2b6cb0;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14181c;
    --panel: #1b2026;
    --ink: #e6ebef;
    --muted: #9aa8b4;
    --line: #303941;
    --high: #6fcf97;
    --mid: #f2c94c;
    --low: #eb7a7a;
    --uncovered: #3a2224;
    --covered: #1e2f26;
    --accent: #7fb3e6;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 2rem 1.25rem 4rem;
  background: var(--bg);
  color: var(--ink);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
}
main { max-width: 1080px; margin: 0 auto; }
h1 { font-size: 1.6rem; margin: 0 0 0.35rem; }
p.meta { color: var(--muted); margin: 0 0 1.5rem; font-size: 0.9rem; }
a { color: var(--accent); }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.75rem; margin-bottom: 1.75rem; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 0.9rem 1rem; }
.card h2 { font-size: 0.8rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); margin: 0 0 0.35rem; }
.card .big { font-size: 1.7rem; font-weight: 650; font-variant-numeric: tabular-nums; }
.card .ratio { color: var(--muted); font-size: 0.85rem; margin-left: 0.4rem; }
table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
th, td { padding: 0.55rem 0.75rem; text-align: left; border-bottom: 1px solid var(--line); vertical-align: top; }
th { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
tbody tr:last-child td { border-bottom: none; }
td.stat { white-space: nowrap; font-variant-numeric: tabular-nums; }
td.stat .ratio { color: var(--muted); font-size: 0.8rem; margin-left: 0.4rem; }
.high .value { color: var(--high); }
.mid .value { color: var(--mid); }
.low .value { color: var(--low); }
.none .value { color: var(--muted); }
td.file { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 0.88rem; word-break: break-all; }
td.missing { color: var(--muted); white-space: nowrap; }
table.code td { padding: 0 0.6rem; border-bottom: 1px solid var(--line); font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 0.82rem; line-height: 1.55; }
table.code th.num { text-align: right; width: 4.5rem; }
table.code td.num { text-align: right; color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
table.code td.code { white-space: pre-wrap; word-break: break-word; }
table.code tr.covered td.code { background: var(--covered); }
table.code tr.uncovered td { background: var(--uncovered); }
table.code tr.uncovered td.num { color: var(--low); font-weight: 600; }
.note { background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--mid); border-radius: 8px; padding: 0.7rem 0.9rem; color: var(--muted); font-size: 0.9rem; margin: 1rem 0; }
.back { display: inline-block; margin-bottom: 1rem; font-size: 0.9rem; }
`;

function page(title, body) {
  return `<!doctype html>
<html lang="es">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="${body.stylesheetHref}">
<main>
${body.content}
</main>
`;
}

function renderIndex(files, totals, options) {
  const rows = files
    .map(
      ({ record, summary, href }) => `<tr>
      <td class="file"><a href="${href}">${escapeHtml(record.file)}</a></td>
      ${statCell(summary.lines)}
      ${statCell(summary.branches)}
      ${statCell(summary.functions)}
      <td class="missing">${escapeHtml(uncoveredRanges(record))}</td>
    </tr>`,
    )
    .join('\n');

  const card = (label, value) =>
    `<div class="card"><h2>${label}</h2><span class="big ${level(percent(value))}">` +
    `${formatPercent(percent(value))}</span><span class="ratio">${value.hit}/${value.total}</span></div>`;

  const content = `<h1>${escapeHtml(options.title)}</h1>
<p class="meta">${files.length} archivo(s) · generado ${escapeHtml(options.generatedAt)} desde <code>${escapeHtml(options.lcovName)}</code></p>
<section class="cards">
  ${card('Líneas', totals.lines)}
  ${card('Ramas', totals.branches)}
  ${card('Funciones', totals.functions)}
</section>
<table>
  <thead><tr><th>Archivo</th><th>Líneas</th><th>Ramas</th><th>Funciones</th><th>Sin cubrir</th></tr></thead>
  <tbody>
${rows}
  </tbody>
</table>`;

  return page(options.title, { content, stylesheetHref: 'style.css' });
}

function readSource(root, file) {
  try {
    return readFileSync(path.resolve(root, file), 'utf8').split(/\r?\n/);
  } catch {
    return null;
  }
}

function renderFile(record, summary, options) {
  const source = readSource(options.root, record.file);
  const uncovered = uncoveredRanges(record);
  const lastLine = Math.max(
    source === null ? 0 : source.length,
    ...[...record.lines.keys()],
    0,
  );

  const rows = [];
  for (let lineNumber = 1; lineNumber <= lastLine; lineNumber += 1) {
    const hits = record.lines.get(lineNumber);
    const state = hits === undefined ? '' : hits > 0 ? 'covered' : 'uncovered';
    const code = source === null ? '' : (source[lineNumber - 1] ?? '');
    rows.push(
      `<tr class="${state}"><td class="num">${lineNumber}</td>` +
        `<td class="num">${hits === undefined ? '' : hits}</td>` +
        `<td class="code">${escapeHtml(code) || '&#160;'}</td></tr>`,
    );
  }

  const content = `<a class="back" href="../index.html">← Volver al resumen</a>
<h1>${escapeHtml(record.file)}</h1>
<p class="meta">Líneas ${formatPercent(percent(summary.lines))} (${summary.lines.hit}/${summary.lines.total}) ·
ramas ${formatPercent(percent(summary.branches))} (${summary.branches.hit}/${summary.branches.total}) ·
funciones ${formatPercent(percent(summary.functions))} (${summary.functions.hit}/${summary.functions.total})${
    uncovered === '' ? '' : ` · sin cubrir: ${escapeHtml(uncovered)}`
  }</p>
${source === null ? '<p class="note">No se encontró el archivo en <code>' + escapeHtml(options.root) + '</code>; se muestran solo las líneas con datos de cobertura, sin código fuente.</p>' : ''}
<table class="code">
  <thead><tr><th class="num">Línea</th><th class="num">Éxitos</th><th>Código</th></tr></thead>
  <tbody>
${rows.join('\n')}
  </tbody>
</table>`;

  return page(`${options.title} · ${record.file}`, { content, stylesheetHref: '../style.css' });
}

/**
 * Escribe el informe y devuelve un resumen de lo generado.
 * Lanza un error si el lcov está vacío: mejor fallar que publicar un artefacto
 * que parezca correcto pero no mida nada.
 */
export function generateHtmlReport({ lcovPath, outDir, root = process.cwd(), title = DEFAULT_TITLE }) {
  const records = parseLcov(readFileSync(lcovPath, 'utf8'));
  if (records.length === 0) {
    throw new Error(`no hay registros de cobertura en ${lcovPath}`);
  }

  const filesDir = path.join(outDir, 'files');
  mkdirSync(filesDir, { recursive: true });

  const totals = {
    lines: { hit: 0, total: 0 },
    branches: { hit: 0, total: 0 },
    functions: { hit: 0, total: 0 },
  };
  const files = records.map((record, index) => {
    const summary = summarize(record);
    addTotals(totals, summary);
    return { record, summary, href: `files/${slugFor(record.file, index)}` };
  });

  const options = {
    title,
    root,
    generatedAt: new Date().toISOString(),
    lcovName: path.basename(lcovPath),
  };

  writeFileSync(path.join(outDir, 'style.css'), STYLES);
  writeFileSync(path.join(outDir, 'index.html'), renderIndex(files, totals, options));
  for (const { record, summary, href } of files) {
    writeFileSync(path.join(outDir, href), renderFile(record, summary, options));
  }

  return { files: files.length, totals, outDir };
}

function parseArgs(argv) {
  const positional = [];
  const options = { root: process.cwd(), title: DEFAULT_TITLE };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') options.root = path.resolve(argv[++index] ?? '.');
    else if (arg === '--title') options.title = argv[++index] ?? DEFAULT_TITLE;
    else if (arg.startsWith('--root=')) options.root = path.resolve(arg.slice(7));
    else if (arg.startsWith('--title=')) options.title = arg.slice(8);
    else positional.push(arg);
  }
  return { positional, options };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const [lcovPath, outDir] = positional;
  if (!lcovPath || !outDir) {
    console.error('Uso: node scripts/lcov-html.mjs <lcov.info> <salida-html> [--root <dir>] [--title <texto>]');
    process.exitCode = 2;
  } else {
    try {
      const { files, totals } = generateHtmlReport({
        lcovPath: path.resolve(lcovPath),
        outDir: path.resolve(outDir),
        root: options.root,
        title: options.title,
      });
      console.log(
        `Informe HTML de cobertura: ${files} archivo(s), ` +
          `líneas ${formatPercent(percent(totals.lines))}, ` +
          `ramas ${formatPercent(percent(totals.branches))}, ` +
          `funciones ${formatPercent(percent(totals.functions))} → ${path.resolve(outDir)}`,
      );
    } catch (error) {
      console.error(`No se pudo generar el informe HTML: ${error.message}`);
      process.exitCode = 1;
    }
  }
}
