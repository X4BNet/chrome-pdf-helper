const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ERROR_CODES = Object.freeze({
  INVALID_ARGUMENTS: 'invalid-arguments',
  PREPARE_WORKSPACE: 'prepare-workspace',
  READ_INPUT: 'read-input',
  LAUNCH_BROWSER: 'launch-browser',
  CREATE_PAGE: 'create-page',
  RENDER_HTML: 'render-html',
  CHECK_READINESS: 'check-readiness',
  WRITE_PDF: 'write-pdf',
  CLOSE_BROWSER: 'close-browser',
  UNEXPECTED: 'unexpected',
});

const ERROR_MESSAGES = Object.freeze({
  [ERROR_CODES.INVALID_ARGUMENTS]: 'an input HTML file and output PDF file are required',
  [ERROR_CODES.PREPARE_WORKSPACE]: 'temporary browser workspace could not be prepared',
  [ERROR_CODES.READ_INPUT]: 'input HTML file could not be read',
  [ERROR_CODES.LAUNCH_BROWSER]: 'Google Chrome could not be started',
  [ERROR_CODES.CREATE_PAGE]: 'browser page could not be created',
  [ERROR_CODES.RENDER_HTML]: 'HTML could not be rendered',
  [ERROR_CODES.CHECK_READINESS]: 'page readiness could not be checked',
  [ERROR_CODES.WRITE_PDF]: 'PDF file could not be written',
  [ERROR_CODES.CLOSE_BROWSER]: 'Google Chrome could not be closed',
  [ERROR_CODES.UNEXPECTED]: 'an unexpected error occurred',
});

const CLEANUP_WARNING = 'temporary browser data could not be removed';
const STRICT_READINESS_MARKER = '<meta name="x4b-pdf-readiness" content="strict-v1">';
const MINIMUM_PDF_BYTES = 1024;

/**
 * An expected PDF generation failure with a stable error code and original cause.
 */
class PdfGenerationError extends Error {
  /**
   * @param {string} code Stable error code from ERROR_CODES.
   * @param {unknown} cause The original failure, retained only for safe summarisation.
   */
  constructor(code, cause) {
    super(ERROR_MESSAGES[code] || ERROR_MESSAGES[ERROR_CODES.UNEXPECTED]);
    this.name = 'PdfGenerationError';
    this.code = code;
    this.cause = cause;
  }
}

/**
 * Return a short error cause only when it cannot expose paths, URLs, code, or stack output.
 *
 * @param {unknown} error The original error.
 * @returns {string|null} A safe single-line cause summary, if available.
 */
function getSafeCauseSummary(error) {
  if (!error || typeof error !== 'object' || typeof error.message !== 'string') {
    return null;
  }

  const summary = error.message.trim();
  if (summary === '' || summary.length > 200 || /[\r\n]/.test(summary)) {
    return null;
  }

  if (
    /(?:https?:\/\/|file:\/\/|node:|[a-z]:[\\/]|(?:^|\s)at\s+|[\\/]|\b(?:error|exception|stack)\s*:|[{};])/i.test(summary)
  ) {
    return null;
  }

  return summary;
}

/**
 * Format a fatal helper error for stderr without exposing a stack trace or source code.
 *
 * @param {unknown} error The error to format.
 * @returns {string} A single-line, user-facing error message.
 */
function formatFatalError(error) {
  const knownError = error instanceof PdfGenerationError
    ? error
    : new PdfGenerationError(ERROR_CODES.UNEXPECTED, error);
  const causeSummary = getSafeCauseSummary(knownError.cause);
  const causeSuffix = causeSummary === null ? '' : ` Cause: ${causeSummary}.`;

  return `PDF generation failed: ${knownError.message}.${causeSuffix}`;
}

/**
 * Format a non-fatal cleanup warning for stderr without exposing internal details.
 *
 * @param {unknown} error The cleanup error to format.
 * @returns {string} A single-line, user-facing warning message.
 */
function formatCleanupWarning(error) {
  const causeSummary = getSafeCauseSummary(error);
  const causeSuffix = causeSummary === null ? '' : ` Cause: ${causeSummary}.`;

  return `PDF generation warning: ${CLEANUP_WARNING}.${causeSuffix}`;
}

/**
 * Parse the helper command line into absolute input and output paths.
 *
 * @param {string[]} argv The Node command-line arguments.
 * @param {typeof path} pathModule The path implementation to use.
 * @returns {{inputFile: string, outputFile: string}} The resolved file paths.
 * @throws {PdfGenerationError} When exactly two file arguments are not supplied.
 */
function parseArguments(argv, pathModule = path) {
  if (!Array.isArray(argv) || argv.length !== 4) {
    throw new PdfGenerationError(ERROR_CODES.INVALID_ARGUMENTS);
  }

  return {
    inputFile: pathModule.resolve(argv[2]),
    outputFile: pathModule.resolve(argv[3]),
  };
}

/**
 * Wrap a failure with its stable PDF-generation error code.
 *
 * @param {string} code Stable error code from ERROR_CODES.
 * @param {unknown} error The original failure.
 * @returns {PdfGenerationError} The wrapped error.
 */
function asPdfGenerationError(code, error) {
  return error instanceof PdfGenerationError ? error : new PdfGenerationError(code, error);
}

/**
 * Execute a synchronous or asynchronous stage and label any error it produces.
 *
 * @template T
 * @param {string} code Stable error code from ERROR_CODES.
 * @param {() => T|Promise<T>} callback The stage implementation.
 * @returns {Promise<T>} The stage result.
 */
async function runStage(code, callback) {
  try {
    return await callback();
  } catch (error) {
    throw asPdfGenerationError(code, error);
  }
}

/**
 * Build the runtime dependencies used by PDF generation.
 *
 * @param {Partial<PdfRuntime>} overrides Dependencies supplied by tests.
 * @returns {PdfRuntime} The complete runtime dependency set.
 */
function createRuntime(overrides = {}) {
  return {
    fs,
    path,
    launchBrowser: (options) => require('puppeteer').launch(options),
    createTemporaryDirectory: () => fs.mkdtempSync(path.join(os.tmpdir(), 'chrome-')),
    removeTemporaryDirectory: (directory) => fs.rmSync(directory, { recursive: true, force: true }),
    getCurrentDirectory: () => process.cwd(),
    changeDirectory: (directory) => process.chdir(directory),
    getHomeDirectory: () => process.env.HOME,
    setHomeDirectory: (directory) => {
      if (directory === undefined) {
        delete process.env.HOME;
        return;
      }

      process.env.HOME = directory;
    },
    sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    ...overrides,
  };
}

/**
 * Return the message exposed by Puppeteer's cross-realm page error object.
 *
 * @param {unknown} error Browser page error.
 * @returns {string} A non-empty error description.
 */
function describePageError(error) {
  if (error && typeof error === 'object' && typeof error.message === 'string' && error.message.trim() !== '') {
    return error.message.trim();
  }
  const description = String(error).trim();
  return description === '' ? 'unknown browser exception' : description;
}

/**
 * Wait for the page-ready signal for up to the existing ten-second limit.
 *
 * @param {{evaluate: (callback: () => string) => Promise<string>}} page The Puppeteer page.
 * @param {(milliseconds: number) => Promise<void>} sleep The timer implementation.
 * @param {boolean} strict Whether timeout and error states must fail generation.
 * @param {unknown[]} pageErrors Browser page errors captured during rendering.
 * @returns {Promise<void>} Resolves after readiness is satisfied.
 */
async function waitForPageReady(page, sleep, strict = false, pageErrors = []) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (strict && pageErrors.length > 0) {
      throw new Error(`Browser failure - ${describePageError(pageErrors[0])}`);
    }
    const status = await page.evaluate(() => window.status);
    if (status === 'ready') {
      if (strict) {
        const valid = await page.evaluate(() => {
          const readinessMarker = document.querySelector('meta[name="x4b-pdf-readiness"][content="strict-v1"]');
          if (!readinessMarker) return false;
          const manifestElement = document.getElementById('weekly-report-manifest');
          if (!manifestElement) return true;
          const header = document.getElementById('weekly-report-header');
          const footer = document.getElementById('weekly-report-footer');
          if (!header || !footer) return false;
          let manifest;
          try {
            manifest = JSON.parse(manifestElement.textContent);
          } catch {
            return false;
          }
          if (manifest.schema_version !== 1 || manifest.report_type !== 'weekly-filtering' || !Array.isArray(manifest.expected_sections) || !Array.isArray(manifest.sections)) return false;
          if (manifest.expected_sections.length !== manifest.sections.length) return false;
          const expected = new Map(manifest.expected_sections.map((section) => [section.key, section]));
          if (expected.size !== manifest.expected_sections.length) return false;
          return manifest.sections.every((section) => {
            const descriptor = expected.get(section.key);
            const graph = document.getElementById(section.graph_id);
            return descriptor && descriptor.type === section.type && descriptor.graph_id === section.graph_id && graph && graph.dataset.weeklyReportGraph === section.key && graph.dataset.renderStatus === 'ready' && (graph.querySelector('canvas') || graph.querySelector('.attack-plot-placeholder'));
          });
        });
        if (!valid) {
          throw new Error('Strict document validation failed');
        }
      }
      return;
    }
    if (strict && status === 'error') {
      throw new Error('Page reported a render error');
    }

    await sleep(100);
  }
  if (strict) {
    throw new Error('Page readiness timed out');
  }
}

/**
 * Validate the minimum structure of generated PDF bytes.
 *
 * @param {Buffer|Uint8Array} pdf Generated PDF bytes.
 * @returns {void}
 */
function validatePdfBuffer(pdf) {
  const buffer = Buffer.from(pdf || []);
  if (buffer.length < MINIMUM_PDF_BYTES || buffer.subarray(0, 5).toString('ascii') !== '%PDF-' || !buffer.toString('ascii').trimEnd().endsWith('%%EOF')) {
    throw new Error('Generated PDF failed structural validation');
  }
}

/**
 * Render an HTML file to PDF and return an optional non-fatal cleanup warning.
 *
 * @param {string} inputFile Absolute input HTML path.
 * @param {string} outputFile Absolute output PDF path.
 * @param {Partial<PdfRuntime>} dependencyOverrides Dependencies supplied by tests.
 * @returns {Promise<{cleanupWarning: unknown|null}>} Completion details for the CLI.
 * @throws {PdfGenerationError} When PDF generation cannot complete.
 */
async function generatePdf(inputFile, outputFile, dependencyOverrides = {}) {
  const runtime = createRuntime(dependencyOverrides);
  const html = await runStage(ERROR_CODES.READ_INPUT, () => runtime.fs.readFileSync(inputFile, 'utf8'));
  const strictReadiness = html.includes(STRICT_READINESS_MARKER);
  let temporaryDirectory = null;
  let browser = null;
  let primaryError = null;
  let cleanupWarning = null;
  const initialDirectory = runtime.getCurrentDirectory();
  const initialHomeDirectory = runtime.getHomeDirectory();

  try {
    temporaryDirectory = await runStage(
      ERROR_CODES.PREPARE_WORKSPACE,
      () => runtime.createTemporaryDirectory(),
    );
    await runStage(ERROR_CODES.PREPARE_WORKSPACE, () => runtime.changeDirectory(temporaryDirectory));
    await runStage(ERROR_CODES.PREPARE_WORKSPACE, () => runtime.setHomeDirectory(temporaryDirectory));

    browser = await runStage(ERROR_CODES.LAUNCH_BROWSER, () => runtime.launchBrowser({
      executablePath: '/usr/bin/google-chrome-stable',
      headless: 'new',
      timeout: 60000,
      args: [
        '--no-sandbox',
        '--disable-gpu',
        '--disable-setuid-sandbox',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        `--user-data-dir=${temporaryDirectory}/user-data`,
        `--data-path=${temporaryDirectory}/data`,
        `--disk-cache-dir=${temporaryDirectory}/cache`,
        `--homedir=${temporaryDirectory}`,
      ],
    }));

    const page = await runStage(ERROR_CODES.CREATE_PAGE, () => browser.newPage());
    const pageErrors = [];
    if (strictReadiness) {
      await runStage(ERROR_CODES.CREATE_PAGE, () => page.on('pageerror', (error) => pageErrors.push(error)));
    }
    await runStage(ERROR_CODES.RENDER_HTML, () => page.setContent(html));
    await runStage(ERROR_CODES.CHECK_READINESS, () => waitForPageReady(page, runtime.sleep, strictReadiness, pageErrors));
    await runStage(ERROR_CODES.CHECK_READINESS, () => {
      if (strictReadiness && pageErrors.length > 0) throw new Error(`Browser failure - ${describePageError(pageErrors[0])}`);
    });
    const pdf = await runStage(ERROR_CODES.WRITE_PDF, () => page.pdf({
        path: outputFile,
        format: 'A4',
        margin: {
          top: '20px',
          left: '20px',
          right: '20px',
          bottom: '20px',
        },
      }));
    await runStage(ERROR_CODES.CHECK_READINESS, () => {
      if (strictReadiness && pageErrors.length > 0) throw new Error(`Browser failure - ${describePageError(pageErrors[0])}`);
    });
    await runStage(ERROR_CODES.WRITE_PDF, () => validatePdfBuffer(pdf));
  } catch (error) {
    primaryError = asPdfGenerationError(ERROR_CODES.UNEXPECTED, error);
  } finally {
    if (browser !== null) {
      try {
        await browser.close();
      } catch (error) {
        if (primaryError === null) {
          primaryError = asPdfGenerationError(ERROR_CODES.CLOSE_BROWSER, error);
        }
      }
    }

    try {
      runtime.setHomeDirectory(initialHomeDirectory);
      runtime.changeDirectory(initialDirectory);
    } catch (error) {
      if (primaryError === null) {
        primaryError = asPdfGenerationError(ERROR_CODES.PREPARE_WORKSPACE, error);
      }
    }

    if (temporaryDirectory !== null) {
      try {
        runtime.removeTemporaryDirectory(temporaryDirectory);
      } catch (error) {
        cleanupWarning = error;
      }
    }
  }

  if (primaryError !== null) {
    throw primaryError;
  }

  return { cleanupWarning };
}

/**
 * Run the command-line helper and return the intended process exit code.
 *
 * @param {string[]} argv The Node command-line arguments.
 * @param {Partial<PdfRuntime>} dependencyOverrides Dependencies supplied by tests.
 * @param {{stderr: {write: (message: string) => unknown}}} io Standard error output.
 * @returns {Promise<number>} The process exit code.
 */
async function runCli(argv, dependencyOverrides, io) {
  try {
    const runtime = createRuntime(dependencyOverrides);
    const { inputFile, outputFile } = parseArguments(argv, runtime.path);
    const { cleanupWarning } = await generatePdf(inputFile, outputFile, runtime);

    if (cleanupWarning !== null) {
      io.stderr.write(`${formatCleanupWarning(cleanupWarning)}\n`);
    }

    return 0;
  } catch (error) {
    io.stderr.write(`${formatFatalError(error)}\n`);
    return 1;
  }
}

/**
 * Install a one-shot fallback for unhandled asynchronous errors in the executable wrapper.
 *
 * @param {{once: (event: string, callback: (error: unknown) => void) => unknown, stderr: {write: (message: string) => unknown}}} processObject The process to guard.
 * @returns {void}
 */
function installUnhandledErrorReporter(processObject) {
  let hasReported = false;
  const report = (error) => {
    if (hasReported) {
      return;
    }

    hasReported = true;
    processObject.stderr.write(`${formatFatalError(error)}\n`);
    processObject.exitCode = 1;
  };

  processObject.once('uncaughtException', report);
  processObject.once('unhandledRejection', report);
}

/**
 * @typedef {object} PdfRuntime
 * @property {typeof fs} fs Filesystem implementation.
 * @property {typeof path} path Path implementation.
 * @property {(options: object) => Promise<object>} launchBrowser Browser launcher.
 * @property {() => string} createTemporaryDirectory Temporary workspace creator.
 * @property {(directory: string) => void} removeTemporaryDirectory Temporary workspace remover.
 * @property {() => string} getCurrentDirectory Current working directory getter.
 * @property {(directory: string) => void} changeDirectory Working directory setter.
 * @property {() => string|undefined} getHomeDirectory HOME getter.
 * @property {(directory: string|undefined) => void} setHomeDirectory HOME setter.
 * @property {(milliseconds: number) => Promise<void>} sleep Timer implementation.
 */

module.exports = {
  CLEANUP_WARNING,
  ERROR_CODES,
  ERROR_MESSAGES,
  PdfGenerationError,
  createRuntime,
  formatCleanupWarning,
  formatFatalError,
  generatePdf,
  getSafeCauseSummary,
  installUnhandledErrorReporter,
  validatePdfBuffer,
  parseArguments,
  runCli,
  waitForPageReady,
};
