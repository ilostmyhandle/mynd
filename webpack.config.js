const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

module.exports = {
  mode: 'development',
  entry: {
    popup: './popup/popup.js',
    background: './background.js',
    chatgpt: './content/chatgpt.js',
    claude: './content/claude.js',
    gemini: './content/gemini.js'
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js'
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        type: 'javascript/esm'
      }
    ]
  },
  resolve: {
    extensions: ['.js'],
    fullySpecified: false
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: 'manifest.json', to: 'manifest.json' },
        { from: 'popup/popup.html', to: 'popup.html' },
        { from: 'popup/popup.css', to: 'popup.css' }
      ]
    })
  ]
};