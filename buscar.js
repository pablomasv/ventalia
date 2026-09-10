require('dotenv').config();

const fs = require('fs');
const path = require('path');

// Umbral de similitud: por debajo de este valor se considera que la KB no cubre la pregunta
const UMBRAL = 0.50;
const FRAGMENTOS_TOP = 5;

const INDEX_PATH = path.join(__dirname, 'data', 'corpus-index.json');
const MODELO = 'text-embedding-3-small';

let indice = null;

function cargarIndice() {
  if (!indice) {
    const raw = fs.readFileSync(INDEX_PATH, 'utf8');
    indice = JSON.parse(raw);
  }
  return indice;
}

function filtrarPorDominio(fragmentos, dominioRol) {
  if (!dominioRol || dominioRol === 'responsable') return fragmentos;

  if (dominioRol === 'tecnico') {
    return fragmentos.filter(
      (f) => f.dominio === 'tecnico' || f.dominio === 'todos'
    );
  }

  if (dominioRol === 'postventa') {
    return fragmentos.filter(
      (f) => f.dominio === 'postventa' || f.dominio === 'todos'
    );
  }

  return fragmentos;
}

async function obtenerEmbedding(texto) {
  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODELO,
      input: texto,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Error de OpenAI (${response.status}): ${error}`);
  }

  const data = await response.json();
  return data.data[0].embedding;
}

function similitudCoseno(a, b) {
  let producto = 0;
  let normaA = 0;
  let normaB = 0;

  for (let i = 0; i < a.length; i++) {
    producto += a[i] * b[i];
    normaA += a[i] * a[i];
    normaB += b[i] * b[i];
  }

  return producto / (Math.sqrt(normaA) * Math.sqrt(normaB));
}

function coincideProducto(fragmento, referenciaProducto) {
  if (!referenciaProducto) return true;
  return fragmento.producto === referenciaProducto || fragmento.producto === 'todos';
}

function mapearFragmento(fragmento, puntuacion) {
  return {
    id: fragmento.id,
    documento_id: fragmento.documento_id,
    titulo: fragmento.titulo,
    dominio: fragmento.dominio,
    producto: fragmento.producto,
    encabezado: fragmento.encabezado,
    encabezado_padre: fragmento.encabezado_padre ?? null,
    texto: fragmento.texto,
    puntuacion,
  };
}

/**
 * Busca un fragmento del índice por su id completo
 * (`documento#seccion`). Lo usa el servidor para completar el `texto`
 * de fragmentos servidos desde la caché de triaje, que a veces se
 * guardó sin el cuerpo del fragmento.
 */
function obtenerFragmentoPorId(fragmentoId) {
  if (!fragmentoId) return null;
  return cargarIndice().find((f) => f.id === fragmentoId) || null;
}

async function buscar(pregunta, referenciaProducto, opciones = {}) {
  const { dominioRol = null } = opciones;
  const indiceCompleto = cargarIndice();
  const fragmentosDominio = filtrarPorDominio(indiceCompleto, dominioRol);

  const embeddingPregunta = await obtenerEmbedding(pregunta);

  const puntuados = fragmentosDominio
    .map((fragmento) => {
      const puntuacion = similitudCoseno(embeddingPregunta, fragmento.embedding);
      return mapearFragmento(fragmento, puntuacion);
    })
    .sort((a, b) => b.puntuacion - a.puntuacion);

  const indiceSinDominio = referenciaProducto
    ? indiceCompleto.filter((f) => coincideProducto(f, referenciaProducto))
    : indiceCompleto;
  const puntuadosSinFiltroDominio = indiceSinDominio
    .map((fragmento) => {
      const puntuacion = similitudCoseno(embeddingPregunta, fragmento.embedding);
      return mapearFragmento(fragmento, puntuacion);
    })
    .sort((a, b) => b.puntuacion - a.puntuacion);

  const sobreUmbral = puntuados.filter((f) => f.puntuacion >= UMBRAL);
  const aplicables = referenciaProducto
    ? puntuados.filter((f) => coincideProducto(f, referenciaProducto))
    : puntuados;
  const aplicablesSobreUmbral = aplicables.filter((f) => f.puntuacion >= UMBRAL);

  if (aplicablesSobreUmbral.length > 0) {
    return {
      motivo: 'cubierto',
      cubierto: true,
      mejorPuntuacion: aplicablesSobreUmbral[0].puntuacion,
      fragmentos: aplicablesSobreUmbral.slice(0, FRAGMENTOS_TOP),
      descartado: null,
    };
  }

  const sobreUmbralSinDominio = puntuadosSinFiltroDominio.filter(
    (f) => f.puntuacion >= UMBRAL
  );

  if (referenciaProducto && sobreUmbralSinDominio.length > 0) {
    const mejorDescartado = sobreUmbralSinDominio.find(
      (f) => !coincideProducto(f, referenciaProducto)
    );

    if (mejorDescartado) {
      return {
        motivo: 'sin_cobertura_producto',
        cubierto: false,
        mejorPuntuacion: sobreUmbralSinDominio[0].puntuacion,
        fragmentos: [],
        descartado: {
          fragmento: mejorDescartado,
          motivo: `El mejor fragmento (${mejorDescartado.puntuacion.toFixed(4)}) pertenece al producto "${mejorDescartado.producto}", no a "${referenciaProducto}"`,
        },
      };
    }
  }

  if (
    dominioRol &&
    dominioRol !== 'responsable' &&
    sobreUmbralSinDominio.length > 0 &&
    sobreUmbral.length === 0
  ) {
    const mejorFueraDominio = sobreUmbralSinDominio[0];
    return {
      motivo: 'sin_cobertura',
      cubierto: false,
      mejorPuntuacion: mejorFueraDominio.puntuacion,
      fragmentos: [],
      descartado: {
        fragmento: mejorFueraDominio,
        motivo: `El mejor fragmento (${mejorFueraDominio.puntuacion.toFixed(4)}) pertenece al dominio "${mejorFueraDominio.dominio}", fuera del ámbito del rol (${dominioRol})`,
      },
    };
  }

  if (referenciaProducto && sobreUmbralSinDominio.length > 0) {
    const mejorDescartado = sobreUmbralSinDominio.find(
      (f) => !coincideProducto(f, referenciaProducto)
    );

    return {
      motivo: 'sin_cobertura_producto',
      cubierto: false,
      mejorPuntuacion: sobreUmbralSinDominio[0].puntuacion,
      fragmentos: [],
      descartado: {
        fragmento: mejorDescartado || sobreUmbralSinDominio[0],
        motivo: `El mejor fragmento (${(mejorDescartado || sobreUmbralSinDominio[0]).puntuacion.toFixed(4)}) pertenece al producto "${(mejorDescartado || sobreUmbralSinDominio[0]).producto}", no a "${referenciaProducto}"`,
      },
    };
  }

  const mejorGlobal = puntuados[0] || puntuadosSinFiltroDominio[0] || null;

  return {
    motivo: 'sin_cobertura',
    cubierto: false,
    mejorPuntuacion: mejorGlobal ? mejorGlobal.puntuacion : 0,
    fragmentos: [],
    descartado: mejorGlobal
      ? {
          fragmento: mejorGlobal,
          motivo: `Puntuación ${mejorGlobal.puntuacion.toFixed(4)} por debajo del umbral (${UMBRAL})`,
        }
      : null,
  };
}

module.exports = {
  buscar,
  obtenerEmbedding,
  obtenerFragmentoPorId,
  UMBRAL,
  filtrarPorDominio,
};
