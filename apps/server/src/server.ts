import dotenv from "dotenv";
import { resolve } from "node:path";
import { createApp } from "./index.js";

dotenv.config({ path: resolve(process.cwd(), "../../.env") });

const port = Number(process.env.PORT ?? 3001);
createApp().listen(port, () => {
  console.log(`RELAY API listening on http://localhost:${port}`);
});
