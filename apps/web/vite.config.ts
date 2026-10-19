import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  // keep lazy formatter imports inside their isolated module worker
  worker: { format: 'es' }
});
