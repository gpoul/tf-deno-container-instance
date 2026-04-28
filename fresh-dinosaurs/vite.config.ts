import { defineConfig } from "vite";
import { fresh } from "@fresh/plugin-vite";

export default defineConfig({
  plugins: [fresh()],
  build: {
    rollupOptions: {
      external: ["oracle-nosqldb"],
    },
  },
  ssr: {
    external: ["oracle-nosqldb"],
  },
});
