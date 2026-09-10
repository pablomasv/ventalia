/**
 * Capa de acceso al triaje de la IA.
 *
 * El pre-triaje (pretriaje.js) analiza todos los casos abiertos por
 * adelantado y guarda el resultado en /data/triaje-cache.json. Este
 * módulo carga esa caché en memoria al arrancar el servidor y expone
 * funciones para leerla, para registrar análisis en vivo (cuando un
 * caso no está en caché o se fuerza un reanálisis) y para registrar
 * correcciones manuales del agente sobre el equipo asignado.
 *
 * Las correcciones y los análisis en vivo solo viven en memoria: no se
 * reescribe /data/triaje-cache.json desde el servidor, para no pisar el
 * fichero que genera el pre-triaje.
 */

const fs = require('fs');
const path = require('path');
const { analizarCaso } = require('./analizar');
const { obtenerFragmentoPorId } = require('./buscar');

const CACHE_PATH = path.join(__dirname, 'data', 'triaje-cache.json');

let cacheEnMemoria = null;
// Correcciones del agente sobre el triaje. Solo viven en memoria.
// Campos opcionales: equipo, categoria, prioridad + corregido_en.
const correcciones = {}; // { [caseId]: { equipo?, categoria?, prioridad?, corregido_en } }

function cargarCacheDeDisco() {
  if (!fs.existsSync(CACHE_PATH)) return {};

  try {
    const raw = fs.readFileSync(CACHE_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    console.warn('[triaje] No se pudo leer triaje-cache.json:', error.message);
    return {};
  }
}

function guardarCacheEnDisco(cache) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
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
 * Igual que guardarEnMemoria, pero además reescribe triaje-cache.json.
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
  const previa = correcciones[caseId] || {};
  const siguiente = { ...previa, corregido_en: new Date().toISOString() };

  if (cambios.equipo != null) siguiente.equipo = cambios.equipo;
  if (cambios.categoria != null) siguiente.categoria = cambios.categoria;
  if (cambios.prioridad != null) siguiente.prioridad = cambios.prioridad;

  correcciones[caseId] = siguiente;
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
  CACHE_PATH,
  cargarCacheDeDisco,
  guardarCacheEnDisco,
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
