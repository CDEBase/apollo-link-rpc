const path = require('path');
var webpack = require('webpack');
var nodeExternals = require('webpack-node-externals');

module.exports = {
    entry: {
        main: './src/index.ts',
        server: './src/server.ts',
        browser: './src/browser.ts',
    },
    mode: process.env.NODE_ENV || 'development',
    plugins: [
        new webpack.LoaderOptionsPlugin({
          options: {
            test: /\.tsx?$/,
            ts: {
              compiler: 'typescript',
              configFile: 'tsconfig.json'
            },
            tslint: {
              emitErrors: true,
              failOnHint: true
            }
          }
        })
    ],
    devtool: 'inline-source-map',
    module: {
        rules: [
            {
                test: /\.tsx?$/,
                use: 'ts-loader',
                exclude: /node_modules/
            }
        ]
    },
    resolve: {
        extensions: ['.tsx', '.ts', '.js']
    },
    output: {
        filename: '[name].js',
        libraryTarget: "commonjs",
        path: path.resolve(__dirname, 'lib'),
    },
    externals: [
        nodeExternals({ modulesDir: "../../node_modules" }),
        nodeExternals()
    ],
};
