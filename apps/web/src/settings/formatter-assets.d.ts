// describe the self-hosted binary emitted by Vite
declare module 'sh-syntax/main.wasm?url' {
  const url: string;
  export default url;
}

// load the package's browser runtime as an explicit side-effect module
declare module 'sh-syntax/vendors/wasm_exec.cjs';
