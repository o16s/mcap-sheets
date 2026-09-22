// Vite's inline-worker import: `import W from './x.worker?worker&inline'` yields
// a zero-arg constructor for a Worker whose code is bundled inline (no separate
// asset), so consumers of the built library get a self-contained worker.
declare module '*?worker&inline' {
  const workerConstructor: new () => Worker;
  export default workerConstructor;
}
