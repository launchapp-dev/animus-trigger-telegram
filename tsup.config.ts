import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  splitting: false,
  // Shebang on the built bundle so POSIX hosts can `exec` the `bin` target
  // directly without a `node` prefix. The `bin` field in package.json points
  // here, and `chmod +x` in the build script makes it executable.
  banner: { js: "#!/usr/bin/env node" },
});
