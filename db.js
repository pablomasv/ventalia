const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'data', 'ventalia.db');

let conexion = null;

function abrir() {
  if (conexion) return conexion;

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
