// @ts-check
import { babel } from '@rollup/plugin-babel';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import typescript from 'rollup-plugin-typescript2';
import packageJson from './package.json';

export function kebabCaseToPascalCase(string = '') {
  return string.replace(/(^\w|-\w)/g, (replaceString) =>
    replaceString.replace(/-/, '').toUpperCase(),
  );
}

/**
 * 把裸模块 `crypto` / `node:crypto` 解析为浏览器可用的 shim。
 *
 * `sm-crypto-v3`（及其依赖 `@noble/hashes`）的产物内有 Node 内置 `crypto` 的
 * 顶层 `import`（如 `@noble/hashes/cryptoNode.js`）。这些 import 在浏览器 /
 * Web Worker 环境无法解析，即使运行时走 `globalThis.crypto`（webcrypto）分支
 * 也会因 ESM 顶层导入失败导致整个 worker/库加载失败。rollup 对此会告警
 * "Missing shims for Node.js built-in crypto"，必须显式解析。
 *
 * worker 是独立 bundle，本 shim 仅映射到全局 Web Crypto，不引入 Node polyfill。
 * @type {() => import('rollup').Plugin}
 */
function cryptoShim() {
  return {
    name: 'sm-crypto-node-builtin-shim',
    resolveId(id) {
      if (id === 'crypto' || id === 'node:crypto') {
        return '\0sm-crypto-shim';
      }
      return null;
    },
    load(id) {
      if (id === '\0sm-crypto-shim') {
        return `
var _globalCrypto = (typeof globalThis !== 'undefined' && globalThis.crypto) || undefined;
var _web = _globalCrypto;
export var webcrypto = _web;
export var getRandomValues = function (arr) { return (_globalCrypto ? _globalCrypto.getRandomValues(arr) : undefined); };
export default { webcrypto: _web, getRandomValues: getRandomValues, randomBytes: getRandomValues };
`;
      }
      return null;
    },
  };
}

/**
 * @type {import('rollup').InputPluginOption}
 */
export const commonPlugins = [
  // 必须在 nodeResolve 之前，抢先接管 crypto 的模块解析
  cryptoShim(),
  nodeResolve({ browser: true, preferBuiltins: false }),
  commonjs(),
  json(),
  babel({
    babelHelpers: 'bundled',
    plugins: ['@babel/plugin-transform-object-rest-spread'],
    presets: ['@babel/preset-env'],
    extensions: ['.js', '.ts', '.mjs'],
    babelrc: false,
  }),
];

/**
 * @type {import('rollup').RollupOptions}
 */
export default {
  input: 'src/index.ts',
  output: [
    {
      file: `dist/${packageJson.name}.esm.mjs`,
      format: 'es',
      strict: true,
      sourcemap: true,
      compact: true,
      // 单一自包含文件：noble/sm-crypto 个别动态 import 需内联，否则会触发多 chunk
      inlineDynamicImports: true,
    },
    {
      file: `dist/${packageJson.name}.umd.js`,
      format: 'umd',
      strict: true,
      sourcemap: true,
      name: kebabCaseToPascalCase(packageJson.name),
      inlineDynamicImports: true,
      // mangle.safari10: avoid catch/finally identifier reuse that React Native
      // Hermes mis-resolves after catch return (client-sdk-js#1952).
      plugins: [terser({ mangle: { safari10: true } })],
    },
  ],
  plugins: [typescript({ tsconfig: './tsconfig.json' }), ...commonPlugins],
};
