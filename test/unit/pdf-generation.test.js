const { expect } = require('chai');

const {
  ERROR_CODES,
  PdfGenerationError,
  formatCleanupWarning,
  formatFatalError,
  getSafeCauseSummary,
  installUnhandledErrorReporter,
  runCli,
  validatePdfBuffer,
  waitForPageReady,
} = require('../../lib/pdf-generation');

const VALID_ARGUMENTS = ['node', 'chrome-pdf-helper', 'input.html', 'output.pdf'];
const VALID_PDF = Buffer.concat([
  Buffer.from('%PDF-1.7\n'),
  Buffer.alloc(1024),
  Buffer.from('\n%%EOF\n'),
]);

/**
 * Create a writable in-memory stderr stream.
 *
 * @returns {{io: {stderr: {write: (message: string) => void}}, output: () => string}} The stream and output reader.
 */
function createStderr() {
  let output = '';

  return {
    io: {
      stderr: {
        write(message) {
          output += message;
        },
      },
    },
    output: () => output,
  };
}

/**
 * Create a successful browser test double.
 *
 * @param {object} overrides Nested test-double overrides.
 * @returns {object} A Puppeteer-compatible browser double.
 */
function createBrowser(overrides = {}) {
  const page = {
    setContent: async () => undefined,
    evaluate: async () => 'ready',
    on: () => undefined,
    pdf: async () => VALID_PDF,
    ...(overrides.page || {}),
  };

  return {
    newPage: async () => page,
    close: async () => undefined,
    ...(overrides.browser || {}),
  };
}

/**
 * Create dependency overrides for a successful helper invocation.
 *
 * @param {object} overrides Dependency overrides.
 * @returns {object} Runtime dependencies for runCli.
 */
function createRuntime(overrides = {}) {
  const browser = overrides.browserInstance || createBrowser(overrides);
  let currentDirectory = '/original-directory';
  let homeDirectory = '/original-home';

  return {
    fs: {
      readFileSync: () => '<html><body>PDF test</body></html>',
      ...(overrides.fs || {}),
    },
    createTemporaryDirectory: () => '/tmp/chrome-unit-test',
    removeTemporaryDirectory: () => undefined,
    getCurrentDirectory: () => currentDirectory,
    changeDirectory: (directory) => {
      currentDirectory = directory;
    },
    getHomeDirectory: () => homeDirectory,
    setHomeDirectory: (directory) => {
      homeDirectory = directory;
    },
    launchBrowser: async () => browser,
    sleep: async () => undefined,
    ...overrides,
  };
}

/**
 * Assert that a controlled runtime failure emits one clean CLI error line.
 *
 * @param {object} runtime Dependency overrides that force the failure.
 * @param {string} expectedMessage Expected stable error message fragment.
 * @returns {Promise<void>} Resolves after the assertions complete.
 */
async function expectCliFailure(runtime, expectedMessage) {
  const stderr = createStderr();
  const exitCode = await runCli(VALID_ARGUMENTS, runtime, stderr.io);
  const output = stderr.output();

  expect(exitCode).to.equal(1);
  expect(output).to.equal(`PDF generation failed: ${expectedMessage}.\n`);
  expect(output.trim().split('\n')).to.have.length(1);
}

describe('Chrome PDF helper failure formatting', function() {
  it('accepts only structurally complete PDF output', function() {
    expect(() => validatePdfBuffer(VALID_PDF)).not.to.throw();
    expect(() => validatePdfBuffer(Buffer.from('%PDF-1.7\n%%EOF'))).to.throw();
    expect(() => validatePdfBuffer(Buffer.alloc(2048))).to.throw();
    expect(() => validatePdfBuffer(Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(2048)]))).to.throw();
  });

  it('fails strict readiness on timeout and explicit error status', async function() {
    const noSleep = async () => undefined;
    try {
      await waitForPageReady({ evaluate: async () => 'pending' }, noSleep, true, []);
      expect.fail('Expected strict readiness timeout');
    } catch (error) {
      expect(error.message).to.equal('Page readiness timed out');
    }
    try {
      await waitForPageReady({ evaluate: async () => 'error' }, noSleep, true, []);
      expect.fail('Expected explicit render error');
    } catch (error) {
      expect(error.message).to.equal('Page reported a render error');
    }
  });

  it('requires a valid strict document DOM after readiness', async function() {
    let calls = 0;
    const page = { evaluate: async () => (++calls === 1 ? 'ready' : false) };
    try {
      await waitForPageReady(page, async () => undefined, true, []);
      expect.fail('Expected strict document validation failure');
    } catch (error) {
      expect(error.message).to.equal('Strict document validation failed');
    }
  });

  it('accepts a generic strict document without a weekly manifest', async function() {
    let calls = 0;
    const page = { evaluate: async () => (++calls === 1 ? 'ready' : true) };

    await waitForPageReady(page, async () => undefined, true, []);

    expect(calls).to.equal(2);
  });

  it('fails strict readiness when the browser emits a page error', async function() {
    try {
      await waitForPageReady({ evaluate: async () => 'ready' }, async () => undefined, true, [new Error('boom')]);
      expect.fail('Expected browser page error');
    } catch (error) {
      expect(error.message).to.equal('Browser failure - boom');
    }
  });

  it('requires exactly an input HTML file and output PDF file', async function() {
    const stderr = createStderr();
    const exitCode = await runCli(['node', 'chrome-pdf-helper'], createRuntime(), stderr.io);

    expect(exitCode).to.equal(1);
    expect(stderr.output()).to.equal(
      'PDF generation failed: an input HTML file and output PDF file are required.\n',
    );
  });

  it('reports input read failures without leaking a file path', async function() {
    await expectCliFailure(
      createRuntime({
        fs: {
          readFileSync: () => {
            throw new Error("ENOENT: no such file or directory, open '/tmp/private/input.html'");
          },
        },
      }),
      'input HTML file could not be read',
    );
  });

  it('reports temporary workspace setup failures', async function() {
    await expectCliFailure(
      createRuntime({
        createTemporaryDirectory: () => {
          throw new Error('Workspace quota exceeded at /tmp/chrome-unit-test');
        },
      }),
      'temporary browser workspace could not be prepared',
    );
  });

  it('reports Google Chrome launch failures with a safe cause summary', async function() {
    const stderr = createStderr();
    const exitCode = await runCli(
      VALID_ARGUMENTS,
      createRuntime({
        launchBrowser: async () => {
          throw new Error('Browser startup timed out');
        },
      }),
      stderr.io,
    );

    expect(exitCode).to.equal(1);
    expect(stderr.output()).to.equal(
      'PDF generation failed: Google Chrome could not be started. Cause: Browser startup timed out.\n',
    );
  });

  it('reports browser page creation failures', async function() {
    await expectCliFailure(
      createRuntime({
        browser: {
          newPage: async () => {
            throw new Error('Could not create page at /tmp/chrome-unit-test');
          },
        },
      }),
      'browser page could not be created',
    );
  });

  it('reports HTML rendering failures', async function() {
    await expectCliFailure(
      createRuntime({
        page: {
          setContent: async () => {
            throw new Error('Renderer rejected HTML at /tmp/chrome-unit-test');
          },
        },
      }),
      'HTML could not be rendered',
    );
  });

  it('reports page readiness failures', async function() {
    await expectCliFailure(
      createRuntime({
        page: {
          evaluate: async () => {
            throw new Error('Readiness script failed at bundle.js:3:1');
          },
        },
      }),
      'page readiness could not be checked',
    );
  });

  it('reports PDF write failures', async function() {
    await expectCliFailure(
      createRuntime({
        page: {
          pdf: async () => {
            throw new Error('Could not write /tmp/private/output.pdf');
          },
        },
      }),
      'PDF file could not be written',
    );
  });

  it('reports Google Chrome close failures', async function() {
    await expectCliFailure(
      createRuntime({
        browser: {
          close: async () => {
            throw new Error('Could not close Chrome at /tmp/chrome-unit-test');
          },
        },
      }),
      'Google Chrome could not be closed',
    );
  });

  it('emits a single non-fatal cleanup warning after generating a PDF', async function() {
    const stderr = createStderr();
    const exitCode = await runCli(
      VALID_ARGUMENTS,
      createRuntime({
        removeTemporaryDirectory: () => {
          throw new Error('Workspace cleanup delayed');
        },
      }),
      stderr.io,
    );

    expect(exitCode).to.equal(0);
    expect(stderr.output()).to.equal(
      'PDF generation warning: temporary browser data could not be removed. Cause: Workspace cleanup delayed.\n',
    );
    expect(stderr.output().trim().split('\n')).to.have.length(1);
  });

  it('suppresses multiline, path, stack, and code-like cause summaries', function() {
    const unsafeMessages = [
      'The browser failed\n    at generated.bundle.js:3:1',
      'Could not access /tmp/chrome-private',
      'at generated.bundle.js:3:1',
      'const helper = { source: true };',
    ];

    for (const message of unsafeMessages) {
      const error = new PdfGenerationError(ERROR_CODES.UNEXPECTED, new Error(message));
      const output = formatFatalError(error);

      expect(getSafeCauseSummary(error.cause)).to.equal(null);
      expect(output).to.equal('PDF generation failed: an unexpected error occurred.');
      expect(output).not.to.contain(message);
    }
  });

  it('formats standalone unexpected errors without an error stack', function() {
    const output = formatFatalError(new Error('Runtime failure\n    at generated.bundle.js:3:1'));

    expect(output).to.equal('PDF generation failed: an unexpected error occurred.');
    expect(output).not.to.contain('generated.bundle');
  });

  it('reports unexpected runtime failures without exposing their stack', async function() {
    const stderr = createStderr();
    const exitCode = await runCli(
      VALID_ARGUMENTS,
      createRuntime({
        getCurrentDirectory: () => {
          throw new Error('Runtime setup failed\n    at generated.bundle.js:3:1');
        },
      }),
      stderr.io,
    );

    expect(exitCode).to.equal(1);
    expect(stderr.output()).to.equal('PDF generation failed: an unexpected error occurred.\n');
  });

  it('formats cleanup warnings without an error stack', function() {
    const output = formatCleanupWarning(new Error('Unable to delete /tmp/chrome-private\n    at cleanup'));

    expect(output).to.equal('PDF generation warning: temporary browser data could not be removed.');
    expect(output).not.to.contain('/tmp/chrome-private');
  });

  it('reports a global unhandled error only once without exposing its stack', function() {
    const callbacks = {};
    const stderr = createStderr();
    const processObject = {
      once(event, callback) {
        callbacks[event] = callback;
      },
      stderr: stderr.io.stderr,
      exitCode: 0,
    };

    installUnhandledErrorReporter(processObject);
    callbacks.unhandledRejection(new Error('Unhandled failure\n    at generated.bundle.js:3:1'));
    callbacks.uncaughtException(new Error('A second failure'));

    expect(processObject.exitCode).to.equal(1);
    expect(stderr.output()).to.equal('PDF generation failed: an unexpected error occurred.\n');
  });
});
