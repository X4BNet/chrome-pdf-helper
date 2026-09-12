const path = require('path');
const webpack = require('webpack');

module.exports = {
  entry: './index.js',
  target: 'node',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'chrome-pdf-helper.js'
  },
  mode: 'production',
  plugins: [
    new webpack.BannerPlugin({ banner: '#!/usr/bin/env node', raw: true }),
  ],
  node: {
    __dirname: false,
    __filename: false
  }
};
