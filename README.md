# Lector de fuentes

Esto no es una aplicación. Es un programa chico que hace una sola cosa: **abrir las
páginas oficiales de bancos y comercios argentinos y guardar el texto que se ve**.

Corre solo, en GitHub, los lunes y jueves a las 8 de la mañana (hora de Argentina).

## Por qué existe

Las páginas de promociones de los bancos ya casi no vienen escritas en el HTML: llegan
vacías y se arman en el navegador. Bajar el HTML no servía de nada — una corrida entera
traía 2 promociones. Con un navegador de verdad que espera a que la página se arme, las
mismas ocho fuentes devuelven más de 100.000 caracteres de promociones reales.

## Por qué es público

Lo único que guarda son **páginas que cualquiera puede abrir en su navegador**. No hay
nada privado acá: ni claves, ni datos de personas, ni código de la aplicación.

Es público para que el programa que interpreta esos textos pueda leerlos por internet,
sin depender de ninguna computadora en particular.

## Qué hay acá

| Archivo | Qué es |
|---|---|
| `fuentes.json` | La lista de sitios. Agregar uno es sumar un renglón. |
| `leer.mjs` | El lector. Abre, espera, hace scroll y copia el texto. |
| `crudo/` | Lo que devolvió cada página, sin interpretar. |
| `crudo/_resumen.md` | Cómo salió la última corrida y cuál falló. |

## Por qué no interpreta nada

Podría haber escrito un programa que, además de abrir la página, entienda dónde está cada
promoción. Sería más automático. También se rompería todo el tiempo: cada vez que un banco
cambia el diseño de su web, esas reglas dejan de servir.

El lector hace una sola cosa y la hace siempre igual: **abre y copia**. Interpretar es
trabajo de quien lee después, que usa criterio y se adapta solo.

## Cada archivo arranca así

```
# fuente: Banco Nación · Descuentos
# url: https://www.bna.com.ar/Personas/DescuentosYPromociones
# leido: 2026-09-26
# hash: 9d6c1bda
# caracteres: 1100
```

El `hash` dice si la página cambió desde la última lectura. Si no cambió, el archivo queda
igual y Git no registra nada: así, cuando algo se mueve, se nota.

Varios bancos ponen el nombre del comercio en el logo y no en el texto. Por eso el lector
escribe el nombre de cada imagen justo donde está la imagen:

```
Miércoles
[imagen: Carrefour]
10
de ahorro
```

## Para correrlo a mano

Pestaña **Actions** → **Leer fuentes** → **Run workflow**. Tarda unos tres minutos.
