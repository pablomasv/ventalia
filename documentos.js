/**
 * Visor de documentos del corpus para la interfaz. Reutiliza
 * `corpus-index.json` como única fuente de verdad (el mismo índice que
 * usa `buscar.js` y que cita el modelo): así el visor siempre muestra
 * exactamente los mismos fragmentos, con el mismo id de sección, que
 * puede citar una afirmación. No vuelve a leer ni a parsear los
 * markdown de /data/corpus por su cuenta.
 */

const fs = require('fs');
const path = require('path');

const INDEX_PATH = path.join(__dirname, 'data', 'corpus-index.json');

let indicePorDocumento = null;

function agruparPorDocumento() {
  if (indicePorDocumento) return indicePorDocumento;

  const fragmentos = JSON.parse(fs.readFileSync(INDEX_PATH, 'utf8'));
  const agrupado = new Map();

  for (const f of fragmentos) {
    if (!agrupado.has(f.documento_id)) {
      agrupado.set(f.documento_id, { documento_id: f.documento_id, titulo: f.titulo, fragmentos: [] });
    }
    agrupado.get(f.documento_id).fragmentos.push(f);
  }

  indicePorDocumento = agrupado;
  return indicePorDocumento;
}

/**
 * Devuelve un documento reconstruido a partir de sus fragmentos
 * indexados, en el orden en que aparecen en el markdown original.
 * Cada fragmento lleva `slug` (la parte del id de fragmento tras la
 * "#", p. ej. "cual-es-el-plazo-de-cobertura"), que es exactamente el
 * ancla a la que apunta un enlace "documento.html?doc=X#slug".
 */
function obtenerDocumento(documentoId) {
  const doc = agruparPorDocumento().get(documentoId);
  if (!doc) return null;

  return {
    documento_id: doc.documento_id,
    titulo: doc.titulo,
    fragmentos: doc.fragmentos.map((f) => ({
      slug: f.id.split('#')[1] || f.id,
      encabezado: f.encabezado,
      encabezado_padre: f.encabezado_padre || null,
      texto: f.texto,
    })),
  };
}

module.exports = { obtenerDocumento };
