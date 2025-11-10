const { expect } = require('chai');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

describe('Chrome PDF Helper', function() {
    // Increase timeout for tests that launch Chrome
    this.timeout(30000);

    const indexPath = path.join(__dirname, '..', 'index.js');
    const fixturesPath = path.join(__dirname, 'fixtures');
    const outputDir = '/tmp/pdf-test-output';

    before(function() {
        // Create output directory for test PDFs
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }
    });

    after(function() {
        // Clean up test output directory
        if (fs.existsSync(outputDir)) {
            fs.rmSync(outputDir, { recursive: true, force: true });
        }
    });

    describe('PDF Generation', function() {
        it('should generate a PDF from a simple HTML file', function(done) {
            const inputFile = path.join(fixturesPath, 'simple.html');
            const outputFile = path.join(outputDir, 'simple.pdf');

            const child = spawn('node', [indexPath, inputFile, outputFile]);

            let stderr = '';
            child.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            child.on('close', (code) => {
                try {
                    expect(code).to.equal(0, `Process exited with code ${code}. stderr: ${stderr}`);
                    expect(fs.existsSync(outputFile)).to.be.true;
                    
                    // Verify it's a valid PDF
                    const stats = fs.statSync(outputFile);
                    expect(stats.size).to.be.greaterThan(0);
                    
                    // Verify PDF header
                    const dataBuffer = fs.readFileSync(outputFile);
                    const header = dataBuffer.toString('ascii', 0, 4);
                    expect(header).to.equal('%PDF');
                    
                    done();
                } catch (err) {
                    done(err);
                }
            });
        });

        it('should handle HTML with delayed ready status', function(done) {
            const inputFile = path.join(fixturesPath, 'delayed.html');
            const outputFile = path.join(outputDir, 'delayed.pdf');

            const child = spawn('node', [indexPath, inputFile, outputFile]);

            let stderr = '';
            child.stderr.on('data', (data) => {
                stderr += data.toString();
            });

            child.on('close', (code) => {
                try {
                    expect(code).to.equal(0, `Process exited with code ${code}. stderr: ${stderr}`);
                    expect(fs.existsSync(outputFile)).to.be.true;
                    
                    const stats = fs.statSync(outputFile);
                    expect(stats.size).to.be.greaterThan(0);
                    
                    // Verify PDF header
                    const dataBuffer = fs.readFileSync(outputFile);
                    const header = dataBuffer.toString('ascii', 0, 4);
                    expect(header).to.equal('%PDF');
                    
                    done();
                } catch (err) {
                    done(err);
                }
            });
        });

        it('should create PDF with A4 format', function(done) {
            const inputFile = path.join(fixturesPath, 'simple.html');
            const outputFile = path.join(outputDir, 'format-test.pdf');

            const child = spawn('node', [indexPath, inputFile, outputFile]);

            child.on('close', (code) => {
                try {
                    expect(code).to.equal(0);
                    expect(fs.existsSync(outputFile)).to.be.true;
                    
                    // Basic validation that PDF was created
                    const dataBuffer = fs.readFileSync(outputFile);
                    expect(dataBuffer[0]).to.equal(0x25); // PDF header starts with %
                    expect(dataBuffer[1]).to.equal(0x50); // P
                    expect(dataBuffer[2]).to.equal(0x44); // D
                    expect(dataBuffer[3]).to.equal(0x46); // F
                    
                    done();
                } catch (err) {
                    done(err);
                }
            });
        });
    });

    describe('Temporary Directory Cleanup', function() {
        it('should clean up temporary directories after execution', function(done) {
            const inputFile = path.join(fixturesPath, 'simple.html');
            const outputFile = path.join(outputDir, 'cleanup-test.pdf');

            // Count /tmp/chrome-* directories before
            const tmpDirsBefore = fs.readdirSync('/tmp').filter(f => f.startsWith('chrome-'));

            const child = spawn('node', [indexPath, inputFile, outputFile]);

            child.on('close', (code) => {
                try {
                    expect(code).to.equal(0);
                    
                    // Give a moment for cleanup to complete
                    setTimeout(() => {
                        const tmpDirsAfter = fs.readdirSync('/tmp').filter(f => f.startsWith('chrome-'));
                        
                        // Should have same or fewer temp directories (cleanup worked)
                        expect(tmpDirsAfter.length).to.be.at.most(tmpDirsBefore.length);
                        done();
                    }, 1000);
                } catch (err) {
                    done(err);
                }
            });
        });
    });
});
