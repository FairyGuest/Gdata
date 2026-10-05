import { writeFileSync, readFileSync } from "node:fs";
import { threadId } from "node:worker_threads";

const marker = new URL("./b.marker.txt", import.meta.url);

export const tests = {
  "file B isolation": async () => {
    const token = "B-" + threadId + "-" + Date.now();
    writeFileSync(marker, token);
    await new Promise((r) => setTimeout(r, 300)); // overlap with file A
    const again = readFileSync(marker, "utf8");
    if (again !== token) throw new Error("marker B was clobbered: " + again);
  },
};
