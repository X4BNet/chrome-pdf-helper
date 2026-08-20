const {
  formatFatalError,
  installUnhandledErrorReporter,
  runCli,
} = require('./lib/pdf-generation');

installUnhandledErrorReporter(process);

runCli(process.argv, {}, process)
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    process.stderr.write(`${formatFatalError(error)}\n`);
    process.exitCode = 1;
  });
