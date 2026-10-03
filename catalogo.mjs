// ============================================================================
// catalogo.mjs · De los textos de crudo/ al catálogo de entidades y productos
//
// Para que una promoción se vea en la app tiene que estar atada a un producto:
// la consulta une promo_productos por dentro, así que una promo sin productos
// no aparece. Y para atarla hace falta que el banco y sus tarjetas existan en
// el catálogo.
//
// Este programa los saca de las propias páginas del banco. No inventa nombres:
// sólo da de alta un producto cuando encuentra la frase textual en el texto
// que el robot bajó. Si la frase no está, no lo da de alta y lo dice.
//
// Las frases que busca, tal como las escriben los bancos:
//   "...con tu Tarjeta de Crédito Banco San Juan y MODO."   -> entidad + crédito
//   "Tarjeta de Débito"  (en la página de tarjetas de débito) -> débito
//
// Salida: salida/catalogo-<fecha>.sql
//
// Uso: node catalogo.mjs
// ============================================================================

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const CRUDO = 'crudo';
const SALIDA = 'salida';

// "...tu Tarjeta de Crédito Banco San Juan y MODO." -> "Banco San Juan"
const CREDITO = /Tarjeta de Cr[ée]dito\s+(Banco\s+[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ]*(?:\s+[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÜÑáéíóúüñ]*){0,3}?)\s+y\s+MODO/;
// En la página de débito, el título de la página
const DEBITO = /^Tarjeta de D[ée]bito$/m;

const leerCabecera = (t) => {
  const h = {};
  for (const l of t.split('\n')) {
    if (!l.startsWith('#')) break;
    const m = l.match(/^#\s*([a-zA-Zá-ú]+)\s*:\s*(.*)$/);
    if (m) h[m[1].toLowerCase()] = m[2].trim();
  }
  return h;
};

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

function main() {
  if (!existsSync(CRUDO)) { console.error(`No encuentro ${CRUDO}/`); process.exit(1); }
  const archivos = readdirSync(CRUDO).filter((f) => f.endsWith('.txt'));
  const hoy = new Date().toISOString().slice(0, 10);

  // 1) Entidades: de qué banco habla cada archivo, según su propia frase
  const entidades = new Map(); // nombre -> { credito, debito, fuentes:Set, url }
  for (const a of archivos) {
    const texto = readFileSync(join(CRUDO, a), 'utf8').replace(/\r/g, '');
    const cab = leerCabecera(texto);
    const m = texto.match(CREDITO);
    if (!m) continue;
    const nombre = m[1].replace(/\s+/g, ' ').trim();
    if (!entidades.has(nombre)) entidades.set(nombre, { credito: false, debito: false, fuentes: new Set(), url: null });
    const e = entidades.get(nombre);
    e.credito = true;
    e.fuentes.add(a);
    e.url ??= cab.url || null;
  }

  // 2) Débito: sólo si la página de débito de ese mismo banco lo dice
  for (const a of archivos) {
    if (!/-tarjetas-debito\.txt$/.test(a)) continue;
    const texto = readFileSync(join(CRUDO, a), 'utf8').replace(/\r/g, '');
    if (!DEBITO.test(texto)) continue;
    const slug = a.replace(/-tarjetas-debito\.txt$/, '');
    // Lo atamos al banco cuyo archivo de beneficios comparte el mismo prefijo
    for (const [nombre, e] of entidades) {
      if ([...e.fuentes].some((f) => f.startsWith(slug))) { e.debito = true; e.fuentes.add(a); }
    }
  }

  if (!entidades.size) { console.log('No encontré ninguna entidad con su frase textual.'); return; }

  const sql = [
    `-- Catálogo de entidades y productos, sacado de las páginas oficiales.`,
    `-- Generado por catalogo.mjs el ${hoy}. No editar a mano: se regenera.`,
    `--`,
    `-- Cada nombre de acá salió textual de la página del propio banco. Si una`,
    `-- tarjeta no figura, es porque su página no la nombró, no porque no exista.`,
    ``,
    `begin;`,
    ``,
  ];
  let nProd = 0;
  for (const [nombre, e] of [...entidades].sort()) {
    sql.push(`-- ${nombre}  ·  de ${[...e.fuentes].sort().join(', ')}`);
    sql.push(`insert into public.entidades (nombre, tipo, sitio_web) values (${q(nombre)}, 'banco', ${e.url ? q(new URL(e.url).origin) : 'null'})`);
    sql.push(`  on conflict (nombre) do nothing;`);
    for (const [prod, tipo, hay] of [['Tarjeta de Crédito', 'credito', e.credito], ['Tarjeta de Débito', 'debito', e.debito]]) {
      if (!hay) { sql.push(`-- (sin ${prod}: la página no la nombra)`); continue; }
      nProd++;
      sql.push(`insert into public.productos (entidad_id, nombre, tipo)`);
      sql.push(`  select id, ${q(prod)}, '${tipo}'::public.tipo_producto from public.entidades where nombre = ${q(nombre)}`);
      sql.push(`  on conflict (entidad_id, nombre) do nothing;`);
    }
    sql.push(``);
  }
  sql.push(`commit;`);
  sql.push(``);
  sql.push(`-- Control: tendrías que ver una fila por banco, con sus productos.`);
  sql.push(`-- select e.nombre, count(p.id) as productos from public.entidades e`);
  sql.push(`--   left join public.productos p on p.entidad_id = e.id`);
  sql.push(`--  group by e.nombre order by e.nombre;`);

  mkdirSync(SALIDA, { recursive: true });
  writeFileSync(join(SALIDA, `catalogo-${hoy}.sql`), sql.join('\n'), 'utf8');

  console.log(`entidades=${entidades.size} productos=${nProd}`);
  for (const [n, e] of [...entidades].sort()) {
    console.log(`  ${n}: ${[e.credito && 'crédito', e.debito && 'débito'].filter(Boolean).join(' + ') || '(ninguno)'}`);
  }
  console.log(`salida/catalogo-${hoy}.sql`);
}

main();
