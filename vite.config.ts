import { defineConfig } from 'vite';
import { resolve } from 'path';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  plugins: [basicSsl()],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'IIIFViewer',
      fileName: 'iiif-viewer',
    },
    rollupOptions: {
      external: ['gl-matrix'],
      output: {
        globals: {
          'gl-matrix': 'glMatrix',
        },
      },
    },
  },
});
