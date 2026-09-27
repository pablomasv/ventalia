const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'data', 'ventalia.db');

let conexion = null;

function asegurarSemilla() {
  if (fs.existsSync(DB_PATH)) return false;
  // semilla.js requiere este módulo: la carga es perezosa para no
  // crear un ciclo al importar db.js.
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const { sembrar } = require('./semilla');
  sembrar();
  return true;
}

function abrir() {
  if (conexion) return conexion;

  // Única regla: si el fichero no está, se crea el directorio y se
  // siembra. No hay un error que pida ejecutar semilla.js a mano.
  const sembrada = asegurarSemilla();
  if (sembrada) {
    console.log(`Base de datos sembrada: ${path.relative(process.cwd(), DB_PATH)}`);
  }

  conexion = new Database(DB_PATH);
  conexion.pragma('journal_mode = WAL');
  conexion.pragma('foreign_keys = ON');
  conexion.pragma('busy_timeout = 5000');
  return conexion;
}

function cerrar() {
  if (!conexion) return;
  conexion.close();
  conexion = null;
}

module.exports = {
  DB_PATH,
  abrir,
  cerrar,
};
