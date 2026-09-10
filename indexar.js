require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { obtenerEmbedding } = require('./buscar');

const CORPUS_DIR = path.join(__dirname, 'data', 'corpus');
const INDEX_PATH = path.join(__dirname, 'data', 'corpus-index.json');

function parseFrontmatter(raw) {
  const meta = {};

  for (const line of raw.split('\n')) {
    const match = line.match(/^(\w+):\s*(.*)$/);
    if (!match) continue;

    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    meta[match[1]] = value;
  }

  return meta;
}

function leerDocumento(filePath) {
  const contenido = fs.readFileSync(filePath, 'utf8');
  const match = contenido.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);

  if (!match) {
    throw new Error(`Cabecera no encontrada en ${path.basename(filePath)}`);
  }

  return {
    meta: parseFrontmatter(match[1]),
    cuerpo: match[2].trim(),
  };
}

/**
 * Convierte un encabezado en un slug apto para formar parte de un id:
 * minúsculas, sin acentos, sin signos de interrogación/puntuación, y
 * espacios/símbolos convertidos en guiones. Es determinista: el mismo
 * encabezado siempre produce el mismo slug.
 */
function normalizarParaId(texto) {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function trocearPorSecciones(cuerpo, nombreArchivo) {
  const fragmentos = [];
  const encabezadosDetectados = [];

  let ultimoEncabezado2 = null;
  let fragmentoActual = null;

  function cerrarFragmento() {
    if (!fragmentoActual) return;

    fragmentoActual.texto = fragmentoActual.texto.trim();
    if (fragmentoActual.texto) {
      fragmentos.push(fragmentoActual);
    }
    fragmentoActual = null;
  }

  function abrirFragmento(encabezado, nivel, encabezadoPadre) {
    cerrarFragmento();
    fragmentoActual = {
      encabezado,
      encabezado_padre: encabezadoPadre,
      texto: '',
    };
    encabezadosDetectados.push({
      nivel,
      encabezado,
      encabezado_padre: encabezadoPadre,
    });
  }

  for (const linea of cuerpo.split('\n')) {
    if (linea.startsWith('### ')) {
      abrirFragmento(linea.slice(4).trim(), 3, ultimoEncabezado2);
    } else if (linea.startsWith('## ')) {
      ultimoEncabezado2 = linea.slice(3).trim();
      abrirFragmento(ultimoEncabezado2, 2, null);
    } else if (linea.startsWith('# ')) {
      ultimoEncabezado2 = null;
      abrirFragmento(linea.slice(2).trim(), 1, null);
    } else if (fragmentoActual) {
      fragmentoActual.texto += (fragmentoActual.texto ? '\n' : '') + linea;
    }
  }

  cerrarFragmento();

  console.log(`\n--- ${nombreArchivo} ---`);
  for (const h of encabezadosDetectados) {
    const padre = h.encabezado_padre ? ` (padre: ${h.encabezado_padre})` : '';
    console.log(`  [nivel ${h.nivel}] ${h.encabezado}${padre}`);
  }
  console.log(`  → ${fragmentos.length} fragmento(s) con contenido`);

  return fragmentos;
}

async function indexar() {
  const ficheros = fs
    .readdirSync(CORPUS_DIR)
    .filter((nombre) => nombre.endsWith('.md'))
    .sort();

  const todosLosFragmentos = [];

  for (const nombre of ficheros) {
    const { meta, cuerpo } = leerDocumento(path.join(CORPUS_DIR, nombre));
    const secciones = trocearPorSecciones(cuerpo, nombre);

    // Slugs ya usados dentro de ESTE documento, para poder desambiguar si
    // dos secciones del mismo fichero tuvieran el mismo encabezado.
    const slugsUsados = new Set();

    console.log(`  Ids de fragmento generados:`);
    for (const seccion of secciones) {
      const tituloFragmento = seccion.encabezado_padre
        ? `${seccion.encabezado_padre} — ${seccion.encabezado}`
        : seccion.encabezado;
      const textoParaEmbedding = `${tituloFragmento}\n\n${seccion.texto}`;
      const embedding = await obtenerEmbedding(textoParaEmbedding);

      let slug = normalizarParaId(seccion.encabezado);
      let sufijo = 2;
      while (slugsUsados.has(slug)) {
        slug = `${normalizarParaId(seccion.encabezado)}-${sufijo}`;
        sufijo += 1;
      }
      slugsUsados.add(slug);

      // Id único de fragmento: "documento#encabezado-normalizado". Es lo
      // que se pasa al modelo en CONOCIMIENTO_CORPUS y lo que el modelo
      // debe devolver en fuente_id, para que la validación pueda comprobar
      // que cita el fragmento exacto y no solo el documento.
      const fragmentoId = `${meta.id}#${slug}`;
      console.log(`    - ${fragmentoId}`);

      todosLosFragmentos.push({
        id: fragmentoId,
        documento_id: meta.id,
        titulo: meta.titulo,
        dominio: meta.dominio,
        producto: meta.producto,
        encabezado: seccion.encabezado,
        encabezado_padre: seccion.encabezado_padre,
        texto: seccion.texto,
        embedding,
      });
    }
  }

  fs.writeFileSync(INDEX_PATH, JSON.stringify(todosLosFragmentos, null, 2), 'utf8');
  console.log(`Indexación completada: ${todosLosFragmentos.length} fragmentos generados.`);
  console.log(`Índice guardado en ${INDEX_PATH}`);
}

indexar().catch((error) => {
  console.error('Error durante la indexación:', error.message);
  process.exit(1);
});
