// Lector de fuentes.
//
// Abre cada página oficial con un navegador de verdad, espera a que termine de
// armarse, y guarda el texto que quedó visible en fuentes/crudo/.
//
// A propósito NO intenta entender las promociones. Solo deja el texto crudo.
// Interpretar lo que dice cada página es trabajo del robot, que usa criterio;
// un programa con reglas fijas se rompe cada vez que un banco rediseña su web.
//
// Corre en GitHub Actions dos veces por semana. No cuesta nada.
//
// Este repositorio es público a propósito: lo único que guarda es el texto de
// páginas que cualquiera puede abrir en su navegador. Así el robot que arma las
// promociones puede leerlo por internet, sin depender de ninguna computadora.

import { chromium } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';

const CARPETA = 'crudo';
const ESPERA_MS = 45000;
const MAX_CARACTERES = 120000;
const MAX_EXPANDIR = 6;

// Limpia el texto: saca líneas repetidas, espacios de más y menús de navegación
function limpiar(texto) {
  const lineas = texto
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 1);

  // Una misma línea repetida muchas veces suele ser el menú o el pie de página
  const vistas = new Map();
  const salida = [];
  for (const linea of lineas) {
    const veces = (vistas.get(linea) ?? 0) + 1;
    vistas.set(linea, veces);
    if (veces <= 2) salida.push(linea);
  }
  return salida.join('\n').slice(0, MAX_CARACTERES);
}

async function leerUna(navegador, fuente) {
  const contexto = await navegador.newContext({
    locale: 'es-AR',
    timezoneId: 'America/Argentina/Buenos_Aires',
    viewport: { width: 1366, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });
  const pagina = await contexto.newPage();

  try {
    await pagina.goto(fuente.url, { waitUntil: 'domcontentloaded', timeout: ESPERA_MS });
    // Muchas páginas cargan las promos después; les damos tiempo y bajamos un poco
    await pagina.waitForTimeout(4000);
    await pagina.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
    await pagina.waitForTimeout(2500);
    await pagina.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await pagina.waitForTimeout(2500);

    // Varias páginas muestran solo las primeras promos y esconden el resto detrás
    // de un botón. Lo apretamos hasta MAX_EXPANDIR veces. Es una regla general,
    // no una regla por sitio: si el botón no está, no pasa nada.
    for (let i = 0; i < MAX_EXPANDIR; i++) {
      const apretado = await pagina.evaluate(() => {
        const esVisible = (el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const candidatos = [...document.querySelectorAll('button, a, [role="button"]')];
        const boton = candidatos.find(
          (el) => /^(mostrar|ver|cargar)\s+(m[áa]s|todas?|todos)/i.test((el.innerText || '').trim()) && esVisible(el),
        );
        if (!boton) return false;
        boton.click();
        return true;
      }).catch(() => false);
      if (!apretado) break;
      await pagina.waitForTimeout(2000);
    }
    await pagina.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await pagina.waitForTimeout(1500);

    // Muchos bancos ponen el nombre del comercio en el logo, no en el texto: sin esto
    // la promo queda como "Lunes 20% de ahorro" y no se sabe de qué comercio habla.
    // Metemos el nombre de cada imagen justo donde está la imagen, para que quede
    // pegado a su promoción y no en una lista suelta al final.
    const crudo = await pagina.evaluate((selector) => {
      const raiz = document.querySelector(selector) ?? document.body;
      const basura = /^(icono?|icon|logo|imagen|image|img|banner|foto|flecha|arrow|next|prev|cerrar|close|abrir|open|menu|men[uú])$/i;
      raiz.querySelectorAll('img[alt], [aria-label], svg[title]').forEach((el) => {
        const crudoAlt = el.getAttribute('alt') ?? el.getAttribute('aria-label') ?? '';
        const nombre = crudoAlt.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (nombre.length < 3 || nombre.length > 120 || basura.test(nombre)) return;
        const marca = document.createElement('div');
        marca.textContent = '[imagen: ' + nombre + ']';
        (el.parentElement ?? raiz).insertBefore(marca, el.nextSibling);
      });
      return raiz.innerText ?? '';
    }, fuente.seccion || 'body');

    const texto = limpiar(crudo);
    if (texto.length < 200) throw new Error(`La página devolvió muy poco texto (${texto.length} caracteres)`);

    return { ok: true, texto };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  } finally {
    await contexto.close().catch(() => {});
  }
}

async function main() {
  const fuentes = JSON.parse(await readFile('fuentes.json', 'utf8'));
  await mkdir(CARPETA, { recursive: true });

  // CHROMIUM_PATH solo se usa para probar en máquinas donde el navegador ya está instalado
  const navegador = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const hoy = new Date().toISOString().slice(0, 10);
  const resumen = [];

  for (const fuente of fuentes) {
    const inicio = Date.now();
    process.stdout.write(`Leyendo ${fuente.nombre} ... `);
    const r = await leerUna(navegador, fuente);
    const segundos = ((Date.now() - inicio) / 1000).toFixed(1);

    const destino = `${CARPETA}/${fuente.archivo}.txt`;

    if (!r.ok) {
      console.log(`ERROR (${segundos}s): ${r.error}`);
      resumen.push({ fuente: fuente.nombre, estado: 'error', detalle: r.error, segundos });
      continue;
    }

    const hash = createHash('md5').update(r.texto).digest('hex').slice(0, 8);
    let anterior = '';
    if (existsSync(destino)) anterior = await readFile(destino, 'utf8');
    const hashAnterior = anterior.match(/^# hash: ([a-f0-9]+)/m)?.[1] ?? '';

    const encabezado =
      `# fuente: ${fuente.nombre}\n` +
      `# url: ${fuente.url}\n` +
      `# leido: ${hoy}\n` +
      `# hash: ${hash}\n` +
      `# caracteres: ${r.texto.length}\n` +
      `# ---------------------------------------------------------------\n` +
      `# Esto es el texto tal cual lo mostró la página. No está interpretado.\n` +
      `# ---------------------------------------------------------------\n\n`;

    await writeFile(destino, encabezado + r.texto, 'utf8');

    const cambio = hash !== hashAnterior;
    console.log(`${cambio ? 'CAMBIÓ' : 'sin cambios'} · ${r.texto.length} caracteres (${segundos}s)`);
    resumen.push({
      fuente: fuente.nombre,
      estado: cambio ? 'cambio' : 'sin_cambios',
      caracteres: r.texto.length,
      segundos,
    });
  }

  await navegador.close();

  // Un resumen legible para saber de un vistazo cómo salió la corrida
  const lineas = [
    `# Corrida del ${hoy}`,
    '',
    '| Fuente | Estado | Caracteres | Segundos |',
    '|---|---|---|---|',
    ...resumen.map(
      (r) => `| ${r.fuente} | ${r.estado}${r.detalle ? ': ' + r.detalle.slice(0, 80) : ''} | ${r.caracteres ?? '-'} | ${r.segundos} |`,
    ),
  ];
  await writeFile(`${CARPETA}/_resumen.md`, lineas.join('\n') + '\n', 'utf8');

  const conError = resumen.filter((r) => r.estado === 'error').length;
  console.log(`\nListo: ${resumen.length} fuentes, ${conError} con error.`);
  // No cortamos con error: que una fuente falle no invalida las otras
}

main().catch((e) => {
  console.error('Falló el lector:', e);
  process.exit(1);
});
