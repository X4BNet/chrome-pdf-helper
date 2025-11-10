const puppeteer = require('puppeteer'),
    fs = require('node:fs'),
    path = require('node:path');

(async () => {
  // Resolve input and output file paths BEFORE changing working directory
  const inputFile = path.resolve(process.argv[process.argv.length - 2]);
  const outputFile = path.resolve(process.argv[process.argv.length - 1]);
  
  // Create unique temporary directory for this run
  const uniqueId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
  const tmpDir = `/tmp/chrome-${uniqueId}`;
  
  // Function to cleanup temporary directory
  const cleanup = () => {
    try {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch (err) {
      console.error('Failed to cleanup temporary directory:', err);
    }
  };

  fs.mkdirSync(tmpDir, { recursive: true });

  // change working directory
  process.chdir(tmpDir);
  process.env.HOME = tmpDir;
  
  const browser = await puppeteer.launch({ 
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
      `--user-data-dir=${tmpDir}/user-data`,
      `--data-path=${tmpDir}/data`,
      `--disk-cache-dir=${tmpDir}/cache`,
      `--homedir=${tmpDir}`
    ]
  });
  
  try {
    const page = await browser.newPage();

    await page.setContent(fs.readFileSync(inputFile, 'utf8'));

    // 10s timeout
    for (let i = 0; i < 100; i++) {
      const status = await page.evaluate(function () {
        return window.status
      })
      if (status == 'ready') break

      await new Promise(resolve => setTimeout(resolve, 100))
    }

    await page.pdf({
      path: outputFile, format: 'A4',
      margin: {
        top: "20px",
        left: "20px",
        right: "20px",
        bottom: "20px"
      }
    })

  } finally {
    await browser.close();
    cleanup();
  }
})();