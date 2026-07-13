import { createApp } from "@example/http";
import { listWidgets } from "./widget.js";

const app = createApp();

app.get("/api/widgets", listWidgets);

export function startServer() {
  return app.listen(3000);
}
