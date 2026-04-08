import { startServer } from "./server.js";

try {
  await startServer();
} catch (error) {
  console.error(error);
  process.exit(1);
}
