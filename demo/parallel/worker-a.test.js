import { writeFileSync, readFileSync } from "node:fs";
import { threadId } from "node:worker_threads";

const marker = new URL("./a.marker.txt", import.meta.url);

export const tests = {
  "file A isolation": async () => {
    const token = "A-" + threadId + "-" + Date.now();
    writeFileSync(marker, token);
    await new Promise((r) => setTimeout(r, 300)); // overlap with file B
    const again = readFileSync(marker, "utf8");
    if (again !== token) throw new Error("marker A was clobbered: " + again);
  },
};
