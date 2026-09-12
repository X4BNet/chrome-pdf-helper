const path = require('path');

module.exports = {
  entry: './index.js',
  target: 'node',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'chrome-pdf-helper.js'
  },
  mode: 'production',
  node: {
    __dirname: false,
    __filename: false
  }
};
