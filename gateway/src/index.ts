import { createApplication } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();
const { app } = await createApplication(config);

const server = app.listen(config.port, config.host, () => {
  console.log(`RiverMoon Codex image gateway listening on ${config.host}:${config.port}`);
});

function shutdown(signal: string) {
  console.log(`Received ${signal}; shutting down`);
  server.close((error) => {
    if (error) {
      console.error("Shutdown failed", error);
      process.exitCode = 1;
    }
  });
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
