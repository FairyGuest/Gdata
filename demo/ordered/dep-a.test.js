import { writeFileSync } from "node:fs";

const marker = new URL("./order.marker.txt", import.meta.url);

export const tests = {
  "producer writes marker": () => {
    writeFileSync(marker, "a-ran-at-" + Date.now());
  },
};
