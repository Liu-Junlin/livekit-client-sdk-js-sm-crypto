module.exports = [
  {
    path: 'dist/livekit-client-sm4.esm.mjs',
    import: '{ Room }',
    limit: '150 kB',
  },
  {
    path: 'dist/livekit-client-sm4.umd.js',
    import: '{ Room }',
    limit: '130 kB',
  },
];
