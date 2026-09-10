require('dotenv').config();

const readline = require('readline');
const { buscar, UMBRAL } = require('./buscar');

function mostrarResultado(resultado) {
  console.log('\n--- Resultado ---');
  console.log(`Umbral configurado: ${UMBRAL}`);
  console.log(`Mejor puntuación: ${resultado.mejorPuntuacion.toFixed(4)}`);
  console.log(`Cubierto: ${resultado.cubierto ? 'sí' : 'no'}`);
  console.log('\nTop 3 fragmentos:\n');

  resultado.fragmentos.forEach((fragmento, i) => {
    console.log(`${i + 1}. [${fragmento.puntuacion.toFixed(4)}] ${fragmento.encabezado}`);
    console.log(`   Documento: ${fragmento.titulo} (${fragmento.id})`);
    console.log(`   Dominio: ${fragmento.dominio}`);
    console.log(`   ${fragmento.texto.slice(0, 120).replace(/\n/g, ' ')}...\n`);
  });
}

async function main() {
  const preguntaArg = process.argv.slice(2).join(' ').trim();

  if (preguntaArg) {
    const resultado = await buscar(preguntaArg);
    mostrarResultado(resultado);
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.question('Escribe tu pregunta: ', async (pregunta) => {
    rl.close();

    if (!pregunta.trim()) {
      console.log('No has escrito ninguna pregunta.');
      process.exit(1);
    }

    try {
      const resultado = await buscar(pregunta.trim());
      mostrarResultado(resultado);
    } catch (error) {
      console.error('Error:', error.message);
      process.exit(1);
    }
  });
}

main().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
