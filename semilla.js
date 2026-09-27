/**
 * Crea data/ventalia.db y la carga desde data/crm.json.
 *
 * crm.json no se modifica: es la semilla inmutable. Si la base ya
 * existe, este script se niega a pisarla; para volver a empezar está
 * reiniciar-db.js.
 *
 * Si todavía existe data/triaje-cache.json, copia cada análisis a
 * analisis_caso (solo para casos que estén en la semilla). A partir de
 * ahí la tabla es la fuente de verdad y el JSON ya no se usa.
 *
 * Uso: node semilla.js
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { DB_PATH } = require('./db');

const CRM_JSON = path.join(__dirname, 'data', 'crm.json');
const CACHE_JSON = path.join(__dirname, 'data', 'triaje-cache.json');

const ESQUEMA = `
CREATE TABLE cuentas (
  id TEXT PRIMARY KEY,
  nombre TEXT NOT NULL,
  pais TEXT,
  filial TEXT,
  idioma TEXT,
  segmento TEXT,
  cliente_desde TEXT,
  contrato_mantenimiento INTEGER NOT NULL CHECK (contrato_mantenimiento IN (0, 1)),
  facturacion_ultimos_12m REAL,
  segmento_comercial TEXT
);

CREATE TABLE contactos (
  id TEXT PRIMARY KEY,
  cuenta_id TEXT NOT NULL REFERENCES cuentas(id),
  nombre TEXT NOT NULL,
  cargo TEXT,
  email TEXT
);

CREATE TABLE productos (
  id TEXT PRIMARY KEY,
  referencia TEXT NOT NULL,
  nombre TEXT NOT NULL,
  gama TEXT,
  dominio TEXT
);

CREATE TABLE pedidos (
  id TEXT PRIMARY KEY,
  cuenta_id TEXT NOT NULL REFERENCES cuentas(id),
  producto_id TEXT NOT NULL REFERENCES productos(id),
  numero_serie TEXT,
  cantidad INTEGER,
  fecha_entrega TEXT,
  instalador TEXT,
  informe_puesta_en_marcha INTEGER NOT NULL CHECK (informe_puesta_en_marcha IN (0, 1))
);

CREATE TABLE casos (
  id TEXT PRIMARY KEY,
  cuenta_id TEXT NOT NULL REFERENCES cuentas(id),
  contacto_id TEXT REFERENCES contactos(id),
  producto_id TEXT REFERENCES productos(id),
  pedido_id TEXT REFERENCES pedidos(id),
  canal TEXT,
  estado TEXT NOT NULL CHECK (estado IN (
    'Nuevo', 'En triaje', 'En curso', 'Esperando cliente', 'Escalado', 'Resuelto', 'Cerrado'
  )),
  categoria TEXT,
  prioridad TEXT,
  equipo TEXT,
  asunto TEXT,
  descripcion TEXT,
  datos_recogidos TEXT,
  causa_raiz TEXT,
  resolucion TEXT,
  creado TEXT NOT NULL,
  actualizado TEXT NOT NULL,
  escenario TEXT,
  nota_demo TEXT
);

CREATE TABLE interacciones (
  id TEXT PRIMARY KEY,
  cuenta_id TEXT NOT NULL REFERENCES cuentas(id),
  fecha TEXT,
  tipo TEXT,
  resumen TEXT
);

CREATE TABLE actividad_caso (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  caso_id TEXT NOT NULL REFERENCES casos(id),
  momento TEXT NOT NULL,
  tipo TEXT NOT NULL,
  actor TEXT NOT NULL,
  detalle TEXT
);

CREATE TABLE analisis_caso (
  caso_id TEXT PRIMARY KEY REFERENCES casos(id),
  analizado_en TEXT NOT NULL,
  resultado TEXT NOT NULL
);

CREATE INDEX idx_casos_estado ON casos(estado);
CREATE INDEX idx_casos_cuenta ON casos(cuenta_id);
CREATE INDEX idx_casos_producto ON casos(producto_id);
CREATE INDEX idx_actividad_caso ON actividad_caso(caso_id);
`;

function bit(valor) {
  return valor ? 1 : 0;
}

function insertarCrm(db, crm) {
  const cuenta = db.prepare(`
    INSERT INTO cuentas (
      id, nombre, pais, filial, idioma, segmento, cliente_desde,
      contrato_mantenimiento, facturacion_ultimos_12m, segmento_comercial
    ) VALUES (
      @id, @nombre, @pais, @filial, @idioma, @segmento, @cliente_desde,
      @contrato_mantenimiento, @facturacion_ultimos_12m, @segmento_comercial
    )
  `);
  const contacto = db.prepare(`
    INSERT INTO contactos (id, cuenta_id, nombre, cargo, email)
    VALUES (@id, @cuenta_id, @nombre, @cargo, @email)
  `);
  const producto = db.prepare(`
    INSERT INTO productos (id, referencia, nombre, gama, dominio)
    VALUES (@id, @referencia, @nombre, @gama, @dominio)
  `);
  const pedido = db.prepare(`
    INSERT INTO pedidos (
      id, cuenta_id, producto_id, numero_serie, cantidad,
      fecha_entrega, instalador, informe_puesta_en_marcha
    ) VALUES (
      @id, @cuenta_id, @producto_id, @numero_serie, @cantidad,
      @fecha_entrega, @instalador, @informe_puesta_en_marcha
    )
  `);
  const caso = db.prepare(`
    INSERT INTO casos (
      id, cuenta_id, contacto_id, producto_id, pedido_id, canal, estado,
      categoria, prioridad, equipo, asunto, descripcion, datos_recogidos,
      causa_raiz, resolucion, creado, actualizado, escenario, nota_demo
    ) VALUES (
      @id, @cuenta_id, @contacto_id, @producto_id, @pedido_id, @canal, @estado,
      @categoria, @prioridad, @equipo, @asunto, @descripcion, @datos_recogidos,
      @causa_raiz, @resolucion, @creado, @actualizado, @escenario, @nota_demo
    )
  `);
  const interaccion = db.prepare(`
    INSERT INTO interacciones (id, cuenta_id, fecha, tipo, resumen)
    VALUES (@id, @cuenta_id, @fecha, @tipo, @resumen)
  `);

  for (const fila of crm.cuentas) {
    cuenta.run({
      ...fila,
      contrato_mantenimiento: bit(fila.contrato_mantenimiento),
    });
  }
  for (const fila of crm.contactos) contacto.run(fila);
  for (const fila of crm.productos) producto.run(fila);
  for (const fila of crm.pedidos) {
    pedido.run({
      ...fila,
      informe_puesta_en_marcha: bit(fila.informe_puesta_en_marcha),
    });
  }
  for (const fila of crm.casos) {
    caso.run({
      id: fila.id,
      cuenta_id: fila.cuenta_id,
      contacto_id: fila.contacto_id ?? null,
      producto_id: fila.producto_id ?? null,
      pedido_id: fila.pedido_id ?? null,
      canal: fila.canal ?? null,
      estado: fila.estado,
      categoria: fila.categoria ?? null,
      prioridad: fila.prioridad ?? null,
      equipo: fila.equipo ?? null,
      asunto: fila.asunto ?? null,
      descripcion: fila.descripcion ?? null,
      datos_recogidos: fila.datos_recogidos ? JSON.stringify(fila.datos_recogidos) : null,
      causa_raiz: fila.causa_raiz ?? null,
      resolucion: fila.resolucion ?? null,
      creado: fila.creado,
      actualizado: fila.creado,
      escenario: fila._escenario ?? null,
      nota_demo: fila._nota_demo ?? null,
    });
  }
  for (const fila of crm.interacciones) interaccion.run(fila);
}

function importarCache(db) {
  if (!fs.existsSync(CACHE_JSON)) return 0;

  const cache = JSON.parse(fs.readFileSync(CACHE_JSON, 'utf8'));
  const existe = db.prepare('SELECT 1 FROM casos WHERE id = ?');
  const insertar = db.prepare(`
    INSERT INTO analisis_caso (caso_id, analizado_en, resultado)
    VALUES (?, ?, ?)
  `);

  let n = 0;
  for (const [casoId, entrada] of Object.entries(cache)) {
    if (!entrada?.resultado) continue;
    if (!existe.get(casoId)) {
      console.warn(`  Análisis omitido (el caso no está en crm.json): ${casoId}`);
      continue;
    }
    insertar.run(casoId, entrada.analizado_en, JSON.stringify(entrada.resultado));
    n += 1;
  }
  return n;
}

function sembrar() {
  if (fs.existsSync(DB_PATH)) {
    throw new Error(
      `Ya existe ${DB_PATH}. Para borrarla y volver a sembrar: node reiniciar-db.js`
    );
  }
  if (!fs.existsSync(CRM_JSON)) {
    throw new Error(`No se encuentra la semilla: ${CRM_JSON}`);
  }

  // En un clon limpio data/ puede no existir si solo había ficheros
  // ignorados. SQLite no crea el directorio padre.
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  const crm = JSON.parse(fs.readFileSync(CRM_JSON, 'utf8'));
  const db = new Database(DB_PATH);

  try {
    db.pragma('foreign_keys = ON');
    db.exec(ESQUEMA);
    const cargar = db.transaction(() => {
      insertarCrm(db, crm);
      return importarCache(db);
    });
    const analisis = cargar();
    console.log(`Base creada en ${DB_PATH}`);
    console.log(`  cuentas: ${crm.cuentas.length}`);
    console.log(`  contactos: ${crm.contactos.length}`);
    console.log(`  productos: ${crm.productos.length}`);
    console.log(`  pedidos: ${crm.pedidos.length}`);
    console.log(`  casos: ${crm.casos.length}`);
    console.log(`  interacciones: ${crm.interacciones.length}`);
    console.log(`  analisis_caso: ${analisis}`);
    console.log('crm.json no se ha modificado.');
  } catch (error) {
    db.close();
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
    throw error;
  }

  db.close();
}

if (require.main === module) {
  try {
    sembrar();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { sembrar, CRM_JSON };
