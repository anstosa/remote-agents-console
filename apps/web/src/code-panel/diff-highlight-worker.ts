// The diff library's highlight worker. Highlights compiles WebAssembly, which the console's
// Content-Security-Policy allows in this worker's script but never in the page.
import '@pierre/diffs/worker/worker.js';
