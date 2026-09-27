/**
 * Capa de acceso al triaje de la IA.
 *
 * El pre-triaje (pretriaje.js) analiza los casos abiertos y guarda el
 * resultado en la tabla analisis_caso. Este módulo la carga en memoria
 * al usarla y expone funciones para leerla, para registrar análisis en
 * vivo y para anotar correcciones manuales del agente.
 *
 * Las correcciones siguen viviendo solo en memoria (se pierden al
 * reiniciar el proceso). Un reanálisis forzado tampoco reescribe la
 * tabla: solo lo hacen el pre-triaje y el alta de un caso, que sí
 * persisten el resultado.
 */

const { analizarCaso } = require('./analizar');
const { obtenerFragmentoPorId } = require('./buscar');
const { abrir } = require('./db');
const { registrarActividad } = require('./crm');

let cacheEnMemoria = null;
// Correcciones del agente sobre el triaje. Solo viven en memoria.
// Campos opcionales: equipo, categoria, prioridad + corregido_en.
const correcciones = {}; // { [caseId]: { equipo?, categoria?, prioridad?, corregido_en } }

function cargarCacheDeDisco() {
  const filas = abrir()
    .prepare('SELECT caso_id, analizado_en, resultado FROM analisis_caso')
    .all();

  const cache = {};
  for (const fila of filas) {
    cache[fila.caso_id] = {
      analizado_en: fila.analizado_en,
      resultado: JSON.parse(fila.resultado),
    };
  }
  return cache;
}

/**
 * Sustituye el contenido de analisis_caso por `cache`, indexado por id
 * de caso. Cada valor es `{ analizado_en, resultado }`.
 */
function guardarAnalisisEnBase(cache) {
  const db = abrir();
  const borrar = db.prepare('DELETE FROM analisis_caso');
  const insertar = db.prepare(
    `INSERT INTO analisis_caso (caso_id, analizado_en, resultado)
     VALUES (?, ?, ?)`
  );

  const escribir = db.transaction((entradas) => {
    borrar.run();
    for (const [casoId, entrada] of Object.entries(entradas)) {
      insertar.run(casoId, entrada.analizado_en, JSON.stringify(entrada.resultado));
    }
  });

  escribir(cache);
}

function guardarCacheEnDisco(cache) {
  guardarAnalisisEnBase(cache);
}

function obtenerCache() {
  if (!cacheEnMemoria) {
    cacheEnMemoria = cargarCacheDeDisco();
  }
  return cacheEnMemoria;
}

function recargarCacheDeDisco() {
  cacheEnMemoria = cargarCacheDeDisco();
  return cacheEnMemoria;
}

function obtenerEntradaCache(caseId) {
  return obtenerCache()[caseId] || null;
}

function guardarEnMemoria(caseId, resultado) {
  const cache = obtenerCache();
  const entrada = {
    analizado_en: new Date().toISOString(),
    resultado,
  };
  cache[caseId] = entrada;
  return entrada;
}

/**
 * Igual que guardarEnMemoria, pero además reescribe analisis_caso.
 * Lo usa el alta por formulario para que el triaje sobreviva a un
 * reinicio del servidor (mismo criterio que pretriaje.js).
 */
function guardarYPersistirEnDisco(caseId, resultado) {
  const entrada = guardarEnMemoria(caseId, resultado);
  guardarCacheEnDisco(obtenerCache());
  return entrada;
}

/**
 * Ejecuta analizarCaso y persiste el resultado en disco. Usado al
 * crear un caso desde el formulario asistido.
 */
async function analizarYPersistir(caseId, rol = 'responsable') {
  const resultado = await analizarCaso(caseId, rol);
  const entrada = guardarYPersistirEnDisco(caseId, resultado);
  return {
    ...enriquecerFragmentosConTexto(resultado),
    _origen_respuesta: 'vivo',
    _analizado_en: entrada.analizado_en,
  };
}

/**
 * Registra una corrección manual del triaje. Acepta cualquiera de
 * equipo / categoria / prioridad; lo que no venga se conserva de una
 * corrección previa del mismo caso. Sustituye a la antigua
 * `corregirEquipo`, que queda como atajo.
 */
function corregirTriaje(caseId, cambios = {}) {
  const equipoPrevio = resumenTriaje(caseId).equipo;
  const previa = correcciones[caseId] || {};
  const siguiente = { ...previa, corregido_en: new Date().toISOString() };

  if (cambios.equipo != null) siguiente.equipo = cambios.equipo;
  if (cambios.categoria != null) siguiente.categoria = cambios.categoria;
  if (cambios.prioridad != null) siguiente.prioridad = cambios.prioridad;

  correcciones[caseId] = siguiente;

  if (cambios.equipo != null && cambios.equipo !== equipoPrevio) {
    const desde = equipoPrevio || 'sin equipo';
    registrarActividad(
      caseId,
      'correccion_enrutado',
      'agente',
      `Enrutado corregido: ${desde} → ${cambios.equipo}`
    ).catch((error) => {
      console.error(
        `[triaje] No se registró la corrección de enrutado de ${caseId}: ${error.message}`
      );
    });
  }

  return siguiente;
}

function corregirEquipo(caseId, nuevoEquipo) {
  return corregirTriaje(caseId, { equipo: nuevoEquipo });
}

/**
 * Completa el `texto` de los fragmentos del resultado cuando la caché
 * se generó sin él (versiones anteriores de analizar.js). Así el
 * bloque "Respaldo" de la vista técnica puede mostrar el fragmento
 * citado sin forzar un reanálisis.
 */
function enriquecerFragmentosConTexto(resultado) {
  if (!resultado?.fragmentos?.length) return resultado;

  const fragmentos = resultado.fragmentos.map((f) => {
    if (f.texto) return f;
    const completo = obtenerFragmentoPorId(f.id);
    return completo ? { ...f, texto: completo.texto, encabezado_padre: f.encabezado_padre || completo.encabezado_padre || null } : f;
  });

  let descartado = resultado.descartado;
  if (descartado?.fragmento && !descartado.fragmento.texto) {
    const completo = obtenerFragmentoPorId(descartado.fragmento.id);
    if (completo) {
      descartado = {
        ...descartado,
        fragmento: { ...descartado.fragmento, texto: completo.texto },
      };
    }
  }

  return { ...resultado, fragmentos, descartado };
}

function obtenerCorreccion(caseId) {
  return correcciones[caseId] || null;
}

/**
 * Lista todas las correcciones manuales hechas por agentes en esta
 * sesión del servidor. Se usa en el panel de responsable como señal
 * de si el enrutado de la IA está acertando: cuantas más correcciones,
 * peor está funcionando el triaje automático.
 */
function listarCorrecciones() {
  return Object.entries(correcciones).map(([caseId, correccion]) => ({
    caseId,
    ...correccion,
  }));
}

/**
 * Vista resumida del triaje de un caso, para listarlo en las colas y en
 * el panel de responsable. Aplica la corrección del agente por encima
 * del resultado de la IA si existe.
 */
function resumenTriaje(caseId) {
  const entrada = obtenerEntradaCache(caseId);
  const correccion = obtenerCorreccion(caseId);

  if (!entrada) {
    return {
      pendiente: true,
      equipo: null,
      prioridad: null,
      categoria: null,
      cubierto: null,
      motivo_cobertura: null,
      origen: 'pendiente',
    };
  }

  const resultado = entrada.resultado;
  const triajeIA = resultado.triaje || {};

  const base = {
    pendiente: false,
    prioridad: correccion?.prioridad ?? triajeIA.prioridad ?? null,
    categoria: correccion?.categoria ?? triajeIA.categoria ?? null,
    equipo: correccion?.equipo ?? triajeIA.equipo ?? null,
    cubierto: resultado.cubierto,
    motivo_cobertura: resultado.cubierto ? null : resultado.motivo,
    analizado_en: entrada.analizado_en,
  };

  if (correccion) {
    return {
      ...base,
      origen: 'agente',
      corregido_en: correccion.corregido_en,
    };
  }

  return {
    ...base,
    origen: 'ia',
  };
}

/**
 * Analiza un caso reutilizando analizarCaso(). Usa la caché salvo que
 * no exista entrada previa o se pida forzar un análisis en vivo.
 */
async function analizarConCache(caseId, rol, { forzar = false } = {}) {
  const entradaExistente = obtenerEntradaCache(caseId);

  if (entradaExistente && !forzar) {
    return {
      ...enriquecerFragmentosConTexto(entradaExistente.resultado),
      _origen_respuesta: 'cache',
      _analizado_en: entradaExistente.analizado_en,
    };
  }

  const resultado = await analizarCaso(caseId, rol);
  const entrada = guardarEnMemoria(caseId, resultado);

  return {
    ...enriquecerFragmentosConTexto(resultado),
    _origen_respuesta: 'vivo',
    _analizado_en: entrada.analizado_en,
  };
}

module.exports = {
  cargarCacheDeDisco,
  guardarCacheEnDisco,
  guardarAnalisisEnBase,
  obtenerCache,
  recargarCacheDeDisco,
  obtenerEntradaCache,
  guardarEnMemoria,
  guardarYPersistirEnDisco,
  analizarYPersistir,
  corregirEquipo,
  corregirTriaje,
  obtenerCorreccion,
  listarCorrecciones,
  resumenTriaje,
  analizarConCache,
};
