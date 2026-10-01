// esbuild's `binary` loader turns a .wasm import into a Uint8Array inlined in the bundle (see
// build-plugin.mjs). TypeScript has no notion of that, so the shape is declared here.
declare module "*.wasm" {
  const bytes: Uint8Array;
  export default bytes;
}
