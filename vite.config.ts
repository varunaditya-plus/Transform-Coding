import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";
import { imagesOptimizer } from "@vinext/cloudflare/images/images-optimizer";

function cloudflareWorkersStub() {
  const id = "\0cloudflare:workers";
  return {
    name: "cloudflare-workers-stub",
    enforce: "pre",
    resolveId(source, importer) {
      if (source === "cloudflare:workers" && importer?.includes("cloudflare-workers-tracing")) return id;
    },
    load(loaded) {
      if (loaded === id) return "export const env = {};\n";
    },
  };
}

export default defineConfig({
  plugins: [
    cloudflareWorkersStub(),
    vinext({
      images: { optimizer: imagesOptimizer() },
      prerender: { routes: "*" },
    }),
    cloudflare({
      viteEnvironment: {
        name: "rsc",
        childEnvironments: ["ssr"],
      },
    }),
  ],
});
