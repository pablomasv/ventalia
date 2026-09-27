const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'data', 'ventalia.db');

let conexion = null;

function asegurarSemilla() {
  if (fs.existsSync(DB_PATH)) return;
  // semilla.js requiere este módulo: la carga es perezosa para no
  // crear un ciclo al importar db.js.
  const { sembrar } = require('./semilla');
  sembrar();
}

function abrir() {
  if (conexion) return conexion;

  // Puede llamarse al importar otro módulo, antes del arranque de
  // server.js. Si el fichero no está, se siembra aquí mismo.
  asegurarSemilla();

  if (!fs.existsSync(DB_PATH)) {
    throw new Error(
      `No existe la base de datos (${path.relative(process.cwd(), DB_PATH)}). Créala con: node semilla.js`
    );
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
