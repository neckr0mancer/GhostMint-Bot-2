const { assertDisposableDatabase } = require('../tests/helpers/disposableDatabase');

const deadline = setTimeout(() => {
  process.stderr.write('Database validation gate blocked: verification timed out.\n');
  process.exit(1);
}, 15_000);

assertDisposableDatabase()
  .then(() => {
    clearTimeout(deadline);
    process.stdout.write('Verified the marked disposable PostgreSQL test database.\n');
  })
  .catch(error => {
    clearTimeout(deadline);
    process.stderr.write(`Database validation gate blocked: ${error.message}\n`);
    process.exitCode = 1;
  });
