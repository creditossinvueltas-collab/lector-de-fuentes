// ============================================================================
// convertir.mjs · De los textos de crudo/ a promociones
//
// Lee cada crudo/<fuente>.txt (lo que el robot vio en la página, sin
// interpretar) y saca de ahí las promociones que la página dice.
//
// Regla de oro: no se inventa nada. Si la página no dice los días, esta
// promoción NO sale con "todos los días": sale marcada como incompleta y
// queda esperando revisión. Lo mismo con las fechas y con el beneficio.
//
// Salida:
//   salida/propuestas-<fecha>.sql  · llamadas a proponer_promo()
//   salida/_informe.md             · qué entró, qué quedó afuera y por qué
//
// Uso:  node convertir.mjs            (lee crudo/, escribe salida/)
//       node convertir.mjs --informe  (sólo el informe, no escribe SQL)
// ============================================================================

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const CRUDO = 'crudo';
const SALIDA = 'salida';

// ---------------------------------------------------------------------------
// Días de la semana. En la base: 1 = lunes ... 7 = domingo.
// ---------------------------------------------------------------------------
const DIAS = {
  lunes: 1, lune: 1,
  martes: 2, marte: 2,
  miercoles: 3, miércoles: 3,
  jueves: 4, jueve: 4,
  viernes: 5, vierne: 5,
  sabado: 6, sábado: 6, sabados: 6, sábados: 6,
  domingo: 7, domingos: 7,
};

const sinAcentos = (s) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const TODOS = [1, 2, 3, 4, 5, 6, 7];

// Devuelve { dias, textual } o null si la línea no habla de días.
// null NO es "todos los días": es "la página no lo dice acá".
function leerDias(linea) {
  const l = sinAcentos(linea).trim();

  // "Todos los días." / "Todos los dias"
  if (/^todos los dias\b/.test(l)) return { dias: TODOS, textual: 'todos los días' };

  // "Lunes a viernes" / "de lunes a domingo"
  const rango = l.match(/\b(?:de\s+)?(lunes|martes|miercoles|jueves|viernes|sabado|domingo)s?\s+a\s+(lunes|martes|miercoles|jueves|viernes|sabado|domingo)s?\b/);
  if (rango) {
    const a = DIAS[rango[1]], b = DIAS[rango[2]];
    if (a && b) {
      const dias = [];
      for (let d = a; ; d = (d % 7) + 1) { dias.push(d); if (d === b) break; if (dias.length > 7) break; }
      return { dias: [...new Set(dias)].sort((x, y) => x - y), textual: rango[0] };
    }
  }

  // "Todos los Viernes, Sábado y Domingo." · "Todos los Martes."
  // Pedimos el "todos los" / "los" adelante para no confundirnos con un
  // "Martes" que sea parte de otra frase cualquiera de la página.
  const lista = l.match(/\b(?:todos los|todas las|los)\s+((?:lunes|martes|miercoles|jueves|viernes|sabado|domingo)s?(?:\s*(?:,|y)\s*(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo)s?)*)/);
  if (lista) {
    const dias = (lista[1].match(/lunes|martes|miercoles|jueves|viernes|sabado|domingo/g) || [])
      .map((n) => DIAS[n]).filter(Boolean);
    if (dias.length) return { dias: [...new Set(dias)].sort((x, y) => x - y), textual: lista[0] };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fechas. Formato de la página: "Desde el 15/09/2026 hasta el 31/12/2026."
// ---------------------------------------------------------------------------
const aISO = (d, m, a) =>
  `${a}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

function fechaValida(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && iso === d.toISOString().slice(0, 10);
}

// Devuelve { inicio, fin } (inicio puede ser null) o null si no hay fechas.
function leerFechas(linea) {
  const l = sinAcentos(linea);
  const F = /(\d{1,2})\/(\d{1,2})\/(\d{4})/g;
  const hallados = [...l.matchAll(F)].map((m) => aISO(+m[1], +m[2], +m[3])).filter(fechaValida);
  if (!hallados.length) return null;

  const desde = /\bdesde\s+el\b/.test(l);
  const hasta = /\b(?:hasta\s+el|valido\s+hasta|vigencia\s+hasta|vigente\s+hasta)\b/.test(l);

  if (desde && hallados.length >= 2) return { inicio: hallados[0], fin: hallados[1] };
  if (hasta) return { inicio: null, fin: hallados[hallados.length - 1] };
  if (hallados.length >= 2) return { inicio: hallados[0], fin: hallados[1] };
  return null; // una sola fecha sin decir si es inicio o fin: no adivinamos
}

// ---------------------------------------------------------------------------
// El beneficio y el comercio, de la línea del título.
// ---------------------------------------------------------------------------
// Las formas que realmente aparecen en las páginas:
//   "20% de descuento en TEMU"
//   "10% de descuento y 6 cuotas sin interés en La Parfumerie"
//   "12 cuotas sin interés en Simmons"
//   "15% de reintegro en Farmacias"
// Y las que descartamos a propósito:
//   "Hasta 30% de ahorro, válido hasta el 30/09/2026"  <- cartel, sin comercio
// ---------------------------------------------------------------------------
function leerBeneficio(linea) {
  const l = linea.trim();
  if (!l || l.length > 160) return null;
  // "Hasta N%" / "Hasta N cuotas": es un techo y casi siempre un cartel
  // de portada sin comercio. No entra.
  if (/^hasta\b/i.test(sinAcentos(l))) return { techo: true };

  const porc = l.match(/^(\d{1,3})\s*%\s*de\s*(descuento|reintegro|ahorro)\b/i);
  const cuot = l.match(/(\d{1,2})\s*cuotas\s+sin\s+inter[eé]s/i);

  // El comercio es lo que va después del último " en " de la línea
  const en = l.match(/\sen\s+(.+?)\s*$/i);
  const comercio = en ? en[1].replace(/[.·•\s]+$/, '').trim() : null;

  if (!porc && !cuot) return null;

  let tipo, porcentaje = null, cuotas = null;
  if (porc) {
    const n = +porc[1];
    if (!(n > 0 && n <= 100)) return null;
    porcentaje = n;
    tipo = /reintegro/i.test(porc[2]) ? 'reintegro' : 'descuento';
    if (cuot) cuotas = +cuot[1];          // el combinado: guardamos las dos cosas
  } else {
    const n = +cuot[1];
    if (!(n > 0 && n <= 36)) return null;
    cuotas = n;
    tipo = 'cuotas_sin_interes';
  }
  if (cuotas !== null && !(cuotas > 0 && cuotas <= 36)) cuotas = null;

  return { tipo, porcentaje, cuotas, comercio, titulo: l };
}

// Tope de reintegro: "tope de $5.000" · "tope mensual $10000"
function leerTope(texto) {
  const m = sinAcentos(texto).match(/tope[^$]{0,20}\$\s*([\d.]+(?:,\d+)?)/);
  if (!m) return null;
  const n = Number(m[1].replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ---------------------------------------------------------------------------
// Cabecera que deja leer.mjs arriba de cada archivo
// ---------------------------------------------------------------------------
function leerCabecera(texto) {
  const h = {};
  for (const l of texto.split('\n')) {
    if (!l.startsWith('#')) break;
    const m = l.match(/^#\s*([a-zá-ú]+)\s*:\s*(.*)$/i);
    if (m) h[sinAcentos(m[1])] = m[2].trim();
  }
  return h;
}

// ---------------------------------------------------------------------------
// El escaneo. Para cada línea que sea un beneficio, mira su vecindario.
// ---------------------------------------------------------------------------
const ANTES = 3;   // líneas hacia arriba: la condición ("EXCLUSIVO CUENTA...")
const DESPUES = 4; // líneas hacia abajo: los días y las fechas

const esImagen = (l) => /^\[imagen:/i.test(l.trim());

// ---------------------------------------------------------------------------
// Fuentes que SON el comercio. En la web de un supermercado, "10% de descuento
// en tu compra" es un descuento EN ESE supermercado: el comercio es la cadena,
// y el "en ..." de la frase es la forma de pago, no un local.
// En la web de un banco es al revés: el banco no es el comercio, y si la
// página no nombra el local, la promo queda incompleta.
// ---------------------------------------------------------------------------
const COMERCIO_PROPIO = {
  'carrefour.txt': 'Carrefour',
  'coto.txt': 'Coto',
  'jumbo.txt': 'Jumbo',
  'disco.txt': 'Disco',
  'vea.txt': 'Vea',
  'changomas.txt': 'ChangoMás',
  'shell.txt': 'Shell',
};

// Palabras que delatan que lo que agarramos no es el nombre de un comercio
// sino la forma de pago o un relleno de la frase.
const NO_ES_COMERCIO = /\b(tarjeta|tarjetas|debito|débito|credito|crédito|visa|mastercard|amex|cabal|cuenta dni|modo|mercado pago|un pago|cuotas|el acto|tu compra|tus compras|todo el surtido|todos los productos|toda la compra|el total|efectivo|plan sueldo|jubilado|pensionado)\b/i;

// Un nombre de comercio no arranca con artículo ni posesivo
const ARRANQUE_MALO = /^(tu|tus|el|la|los|las|un|una|mi|mis|toda|todo|todos|todas)\s/i;

function comercioUsable(c) {
  if (!c) return false;
  const t = c.trim();
  if (t.length < 2 || t.length > 120) return false;
  if (ARRANQUE_MALO.test(t)) return false;
  if (NO_ES_COMERCIO.test(sinAcentos(t))) return false;
  return true;
}

function escanear(lineas, origen, archivo) {
  const propio = COMERCIO_PROPIO[archivo] || null;
  const promos = [];
  for (let i = 0; i < lineas.length; i++) {
    const ben = leerBeneficio(lineas[i]);
    if (!ben) continue;
    if (ben.techo) { promos.push({ descartada: 'techo', linea: lineas[i].trim(), origen }); continue; }

    // Hacia abajo: días y fechas. Nos detenemos si arranca otra promo.
    let dias = null, fechas = null, contexto = [lineas[i].trim()];
    for (let j = i + 1; j <= Math.min(i + DESPUES, lineas.length - 1); j++) {
      const l = lineas[j];
      const otra = leerBeneficio(l);
      if (otra && !otra.techo) break;
      contexto.push(l.trim());
      if (!dias) dias = leerDias(l);
      if (!fechas) fechas = leerFechas(l);
    }
    // Las fechas a veces vienen pegadas en la misma línea del título
    if (!fechas) fechas = leerFechas(lineas[i]);
    if (!dias) dias = leerDias(lineas[i]);

    // Hacia arriba: la condición / con qué se paga
    const condiciones = [];
    // Restos de la interfaz que no son condiciones de la promo
    const RUIDO = /^(conoc[eé] m[aá]s|m[aá]s filtros|ver m[aá]s|ver promo|ver detalle|buscar promociones|todas|filtrar por|anterior|siguiente|empez[aá] a disfrutar|t[eé]rminos y condiciones|bases y condiciones)\.?$/i;
    for (let j = i - 1; j >= Math.max(0, i - ANTES); j--) {
      const l = lineas[j].trim();
      if (!l || esImagen(l)) continue;
      if (leerBeneficio(l) || leerDias(l) || leerFechas(l)) break;
      if (l.length > 120) break;
      if (RUIDO.test(l)) continue;
      condiciones.unshift(l);
    }

    // El comercio: lo que dice la frase, si sirve; si no, la cadena dueña
    // de la página; si tampoco, nada (y la promo queda incompleta).
    const comercio = comercioUsable(ben.comercio) ? ben.comercio.trim() : propio;

    promos.push({
      ...ben,
      comercio,
      dias: dias?.dias ?? null,
      dias_textual: dias?.textual ?? null,
      fecha_inicio: fechas?.inicio ?? null,
      fecha_fin: fechas?.fin ?? null,
      tope: leerTope(contexto.join(' ')),
      condiciones: condiciones.join(' · ') || null,
      origen,
    });
  }
  return promos;
}

// ---------------------------------------------------------------------------
// ¿Está completa? Esto es lo acordado: días + fechas + beneficio + fuente.
// Sin las cuatro cosas no se publica sola; queda como propuesta.
// ---------------------------------------------------------------------------
function faltantes(p, url) {
  const f = [];
  if (!p.comercio || p.comercio.length < 2) f.push('comercio');
  if (!p.dias) f.push('días');
  if (!p.fecha_fin) f.push('fecha de fin');
  if (p.tipo === 'cuotas_sin_interes' ? !p.cuotas : !p.porcentaje) f.push('beneficio');
  if (!url) f.push('fuente');
  return f;
}

// ---------------------------------------------------------------------------
const q = (s) => (s === null || s === undefined ? 'null' : `'${String(s).replace(/'/g, "''")}'`);
const n = (v) => (v === null || v === undefined ? 'null' : String(v));
const arr = (a) => (a ? `'{${a.join(',')}}'::smallint[]` : 'null');

function main() {
  const soloInforme = process.argv.includes('--informe');
  if (!existsSync(CRUDO)) { console.error(`No encuentro la carpeta ${CRUDO}/`); process.exit(1); }

  // Las páginas de tarjetas no traen promos: traen los nombres de los
  // productos para el catálogo. Las lee otro programa, no este.
  const esCatalogo = (f) => /-tarjetas-(credito|debito)\.txt$/.test(f);
  const archivos = readdirSync(CRUDO)
    .filter((f) => f.endsWith('.txt') && !esCatalogo(f))
    .sort();
  const hoy = new Date().toISOString().slice(0, 10);
  const porFuente = [];
  let completas = [], incompletas = [], techos = 0;

  for (const a of archivos) {
    const texto = readFileSync(join(CRUDO, a), 'utf8').replace(/\r/g, '');
    const cab = leerCabecera(texto);
    const url = cab.url || null;
    const nombre = cab.fuente || a.replace(/\.txt$/, '');
    const lineas = texto.split('\n');

    const halladas = escanear(lineas, nombre, a);
    const t = halladas.filter((p) => p.descartada === 'techo').length;
    techos += t;
    const reales = halladas.filter((p) => !p.descartada);

    // Sacamos repetidas dentro del mismo archivo (los carteles se repiten
    // en cada página). La firma de la base se encarga del resto.
    const vistas = new Set();
    const unicas = [];
    for (const p of reales) {
      const k = [sinAcentos(p.comercio || ''), p.tipo, p.porcentaje, p.cuotas, (p.dias || []).join(','), p.fecha_fin].join('|');
      if (vistas.has(k)) continue;
      vistas.add(k); unicas.push(p);
    }

    const c = [], inc = [];
    for (const p of unicas) {
      const f = faltantes(p, url);
      (f.length ? inc : c).push({ ...p, url, fuente_nombre: nombre, faltan: f });
    }
    completas.push(...c); incompletas.push(...inc);
    porFuente.push({ nombre, archivo: a, url, paginas: cab.paginas || '?', halladas: reales.length, unicas: unicas.length, completas: c.length, incompletas: inc.length, techos: t });
  }

  mkdirSync(SALIDA, { recursive: true });

  // ---- informe ----
  const lineasInf = [
    `# Conversión del ${hoy}`,
    '',
    `Promos completas (días + fechas + beneficio + fuente): **${completas.length}**`,
    `Promos incompletas (quedan como propuesta a revisar): **${incompletas.length}**`,
    `Carteles "hasta N%" descartados (no dicen el comercio): **${techos}**`,
    '',
    '| Fuente | Páginas | Halladas | Únicas | Completas | Incompletas |',
    '|---|---|---|---|---|---|',
    ...porFuente.map((f) => `| ${f.nombre} | ${f.paginas} | ${f.halladas} | ${f.unicas} | ${f.completas} | ${f.incompletas} |`),
    '',
    '## Por qué quedaron incompletas',
    '',
  ];
  const motivos = {};
  for (const p of incompletas) { const k = p.faltan.join(' + '); motivos[k] = (motivos[k] || 0) + 1; }
  for (const [k, v] of Object.entries(motivos).sort((a, b) => b[1] - a[1])) lineasInf.push(`- falta ${k}: ${v}`);
  lineasInf.push('', '## Muestra de completas', '');
  for (const p of completas.slice(0, 15)) {
    lineasInf.push(`- **${p.comercio}** · ${p.tipo} ${p.porcentaje ? p.porcentaje + '%' : ''}${p.cuotas ? ' ' + p.cuotas + ' cuotas' : ''} · días ${p.dias.join(',')} · ${p.fecha_inicio || '(sin inicio)'} → ${p.fecha_fin} · ${p.fuente_nombre}`);
  }
  writeFileSync(join(SALIDA, '_informe.md'), lineasInf.join('\n') + '\n', 'utf8');

  if (soloInforme) { console.log(lineasInf.slice(0, 12).join('\n')); return; }

  // ---- SQL ----
  const sql = [
    `-- Promociones leídas por el robot el ${hoy}.`,
    `-- Generado por convertir.mjs. No editar a mano: se regenera en cada corrida.`,
    '--',
    `-- Completas: ${completas.length} · Incompletas: ${incompletas.length}`,
    '--',
    '-- Todo entra por proponer_promo(), que descarta sola las repetidas y las',
    '-- que les faltan datos mínimos. Nada se publica acá: quedan pendientes.',
    '',
    'begin;',
    '',
  ];
  const emitir = (p, nota) => {
    sql.push(`-- ${nota}: ${p.fuente_nombre}`);
    sql.push(`select public.proponer_promo(`);
    sql.push(`  p_corrida        => :corrida,`);
    sql.push(`  p_comercio       => ${q(p.comercio)},`);
    sql.push(`  p_titulo         => ${q(p.titulo.slice(0, 140))},`);
    sql.push(`  p_tipo           => ${q(p.tipo)}::public.tipo_promo,`);
    sql.push(`  p_fecha_inicio   => ${p.fecha_inicio ? q(p.fecha_inicio) + '::date' : 'current_date'},`);
    sql.push(`  p_fecha_fin      => ${q(p.fecha_fin)}::date,`);
    sql.push(`  p_porcentaje     => ${n(p.porcentaje)},`);
    sql.push(`  p_cuotas         => ${n(p.cuotas)},`);
    sql.push(`  p_tope_reintegro => ${n(p.tope)},`);
    sql.push(`  p_dias_semana    => ${p.dias ? arr(p.dias) : `'{1,2,3,4,5,6,7}'::smallint[]`},`);
    sql.push(`  p_condiciones    => ${q(p.condiciones)},`);
    sql.push(`  p_fuente_url     => ${q(p.url)}`);
    sql.push(`);`);
    sql.push('');
  };
  for (const p of completas) emitir(p, 'COMPLETA');
  for (const p of incompletas) emitir(p, `INCOMPLETA (falta ${p.faltan.join(' + ')})`);
  sql.push('commit;');
  writeFileSync(join(SALIDA, `propuestas-${hoy}.sql`), sql.join('\n'), 'utf8');

  console.log(`completas=${completas.length} incompletas=${incompletas.length} techos=${techos}`);
  console.log(`salida/_informe.md y salida/propuestas-${hoy}.sql`);
}

main();
