// Lector de fuentes.
//
// Abre cada página oficial con un navegador de verdad, espera a que termine de
// armarse, recorre TODAS las páginas del listado, y guarda el texto que quedó
// visible en crudo/.
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
const MAX_CARACTERES = 400000;
const MAX_EXPANDIR = 6;
const MAX_PAGINAS = 60;

// Líneas que NUNCA se descartan por repetidas.
//
// Esto arregla un error que nos costó caro: el filtro de abajo tira toda línea
// que aparezca más de dos veces, para matar menús y pies de página. Pero en un
// listado de promociones "Todos los días." se repite en decenas de promos, y a
// partir de la tercera desaparecía. El texto quedaba mostrando la promo SIN sus
// días, y quien lo leyera después asumía que valía siempre.
//
// Perder un día es peor que dejar un menú repetido: manda a alguien al comercio
// un día que no corresponde.
const ESENCIAL =
  /^(todos los|todas las|todo el|lunes|martes|mi[eé]rcoles|jueves|viernes|s[áa]bados?|domingos?|de lunes|desde el|hasta el|v[áa]lido|vigencia|vigente|tope|reintegro|descuento|hasta \d|\d+\s*%|\d+\s*cuotas|sin tope|sin interés|sin interes)/i;

// Limpia el texto: saca líneas repetidas, espacios de más y menús de navegación
function limpiar(texto) {
  const lineas = texto
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 1);

  // Una misma línea repetida muchas veces suele ser el menú o el pie de página,
  // salvo que diga algo de la promoción (días, fechas, topes): eso nunca se tira.
  const vistas = new Map();
  const salida = [];
  for (const linea of lineas) {
    if (ESENCIAL.test(linea)) {
      salida.push(linea);
      continue;
    }
    const veces = (vistas.get(linea) ?? 0) + 1;
    vistas.set(linea, veces);
    if (veces <= 2) salida.push(linea);
  }
  return salida.join('\n').slice(0, MAX_CARACTERES);
}

// Saca el texto visible, poniendo el nombre de cada imagen justo donde está.
//
// Muchos bancos ponen el nombre del comercio en el logo, no en el texto: sin esto
// la promo queda como "Lunes 20% de ahorro" y no se sabe de qué comercio habla.
async function textoVisible(pagina, selector) {
  return pagina.evaluate((sel) => {
    const raiz = document.querySelector(sel) ?? document.body;
    const basura =
      /^(icono?|icon|logo|imagen|image|img|banner|foto|flecha|arrow|next|prev|cerrar|close|abrir|open|menu|men[uú])$/i;
    raiz.querySelectorAll('img[alt], [aria-label], svg[title]').forEach((el) => {
      // Al recorrer varias páginas pasamos por acá más de una vez: no remarcamos
      if (el.dataset.yaMarcado === '1') return;
      const crudoAlt = el.getAttribute('alt') ?? el.getAttribute('aria-label') ?? '';
      const nombre = crudoAlt.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
      if (nombre.length < 3 || nombre.length > 120 || basura.test(nombre)) return;
      el.dataset.yaMarcado = '1';
      const marca = document.createElement('div');
      marca.textContent = '[imagen: ' + nombre + ']';
      (el.parentElement ?? raiz).insertBefore(marca, el.nextSibling);
    });
    return raiz.innerText ?? '';
  }, selector);
}

// Aprieta el botón de "siguiente página" si existe y si no está deshabilitado.
//
// Pide que diga explícitamente "página", para no confundirse con las flechas de
// los carruseles ("Siguiente diapositiva"), que están en casi todas estas webs
// y nos harían girar un banner en vez de avanzar el listado.
async function pasarDePagina(pagina) {
  return pagina
    .evaluate(() => {
      const esVisible = (el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const apagado = (el) =>
        el.hasAttribute('disabled') ||
        el.getAttribute('aria-disabled') === 'true' ||
        el.closest('[aria-disabled="true"], .disabled, [disabled]') !== null;

      const dicePagina = /(siguiente\s+p[áa]gina|p[áa]gina\s+siguiente|next\s+page|ir\s+a\s+la\s+siguiente)/i;
      const candidatos = [...document.querySelectorAll('a, button, [role="button"], [role="link"]')];

      // La etiqueta puede estar en el botón o en el ícono que tiene adentro.
      // Banco Santa Fe pone "Ir a la siguiente página" en la imagen, no en el
      // botón: mirando solo el botón, la flecha quedaba invisible y nos
      // perdíamos 43 de sus 44 páginas.
      const etiquetaDe = (el) => {
        const propia = (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
        const adentro = [...el.querySelectorAll('[aria-label], [title], img[alt]')]
          .map((h) => h.getAttribute('aria-label') || h.getAttribute('title') || h.getAttribute('alt') || '')
          .join(' ');
        return (propia + ' ' + adentro + ' ' + (el.innerText || '')).replace(/\s+/g, ' ').trim();
      };

      const boton = candidatos.find((el) => {
        if (!esVisible(el) || apagado(el)) return false;
        if (el.getAttribute('rel') === 'next') return true;
        return dicePagina.test(etiquetaDe(el));
      });

      if (!boton) return false;
      boton.scrollIntoView({ block: 'center' });
      boton.click();
      return true;
    })
    .catch(() => false);
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
    // Algunas tardan bastante más. Coto arma su listado de legales con
    // JavaScript y tarda unos 13 segundos. En vez de hacer esperar de más a
    // las otras fuentes, se le da tiempo extra sólo a la que lo necesita,
    // con "espera_extra" en fuentes.json (en milisegundos).
    if (fuente.espera_extra) await pagina.waitForTimeout(fuente.espera_extra);
    await pagina.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
    await pagina.waitForTimeout(2500);
    await pagina.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await pagina.waitForTimeout(2500);

    // Varias páginas muestran solo las primeras promos y esconden el resto detrás
    // de un botón. Lo apretamos hasta MAX_EXPANDIR veces. Es una regla general,
    // no una regla por sitio: si el botón no está, no pasa nada.
    for (let i = 0; i < MAX_EXPANDIR; i++) {
      const apretado = await pagina
        .evaluate(() => {
          const esVisible = (el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0;
          };
          const candidatos = [...document.querySelectorAll('button, a, [role="button"]')];
          const boton = candidatos.find(
            (el) =>
              /^(mostrar|ver|cargar)\s+(m[áa]s|todas?|todos)/i.test((el.innerText || '').trim()) && esVisible(el),
          );
          if (!boton) return false;
          boton.click();
          return true;
        })
        .catch(() => false);
      if (!apretado) break;
      await pagina.waitForTimeout(2000);
    }
    await pagina.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await pagina.waitForTimeout(1500);

    // Otras reparten las promos en páginas numeradas. Banco Santa Fe tiene 521
    // promociones en 44 páginas: leyendo solo la primera nos perdíamos el 97%.
    const partes = [];
    let paginas = 0;
    let anterior = '';

    for (let p = 0; p < MAX_PAGINAS; p++) {
      const actual = await textoVisible(pagina, fuente.seccion || 'body');
      // Si el contenido no cambió, el botón no llevaba a ningún lado: cortamos
      if (p > 0 && actual === anterior) break;
      partes.push(actual);
      anterior = actual;
      paginas = p + 1;

      if (partes.join('\n').length > MAX_CARACTERES) break;

      const avanzo = await pasarDePagina(pagina);
      if (!avanzo) break;
      await pagina.waitForTimeout(2500);

      // Si todavia no se actualizo, le damos una segunda chance antes de cortar:
      // varias de estas webs tardan en traer la pagina siguiente.
      const recien = await textoVisible(pagina, fuente.seccion || 'body');
      if (recien === anterior) await pagina.waitForTimeout(3500);
    }

    const texto = limpiar(partes.join('\n'));
    if (texto.length < 200) throw new Error(`La página devolvió muy poco texto (${texto.length} caracteres)`);

    return { ok: true, texto, paginas };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  } finally {
    await contexto.close().catch(() => {});
  }
}

async function main() {
  const todas = JSON.parse(await readFile('fuentes.json', 'utf8'));
  // Una fuente con "activa": false queda en el archivo pero no se lee.
  // Sirve para pausar un sitio que se rompió sin perder la URL ni el motivo.
  const fuentes = todas.filter((f) => f.activa !== false);
  const pausadas = todas.length - fuentes.length;
  if (pausadas > 0) console.log(`(${pausadas} fuentes pausadas, no se leen)`);
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
      `# paginas: ${r.paginas}\n` +
      `# caracteres: ${r.texto.length}\n` +
      `# ---------------------------------------------------------------\n` +
      `# Esto es el texto tal cual lo mostró la página. No está interpretado.\n` +
      `# ---------------------------------------------------------------\n\n`;

    await writeFile(destino, encabezado + r.texto, 'utf8');

    const cambio = hash !== hashAnterior;
    console.log(
      `${cambio ? 'CAMBIÓ' : 'sin cambios'} · ${r.paginas} pág · ${r.texto.length} caracteres (${segundos}s)`,
    );
    resumen.push({
      fuente: fuente.nombre,
      estado: cambio ? 'cambio' : 'sin_cambios',
      paginas: r.paginas,
      caracteres: r.texto.length,
      segundos,
    });
  }

  await navegador.close();

  // Un resumen legible para saber de un vistazo cómo salió la corrida
  const lineas = [
    `# Corrida del ${hoy}`,
    '',
    '| Fuente | Estado | Páginas | Caracteres | Segundos |',
    '|---|---|---|---|---|',
    ...resumen.map(
      (r) =>
        `| ${r.fuente} | ${r.estado}${r.detalle ? ': ' + r.detalle.slice(0, 80) : ''} | ${r.paginas ?? '-'} | ${r.caracteres ?? '-'} | ${r.segundos} |`,
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
