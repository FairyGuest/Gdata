import { readFileSync } from "node:fs";

export const dependsOn = ["dep-a.test.js"];

const marker = new URL("./order.marker.txt", import.meta.url);

export const tests = {
  "consumer sees marker from dependency": () => {
    const content = readFileSync(marker, "utf8"); // throws if A has not run yet
    if (!content.startsWith("a-ran-at-")) throw new Error("unexpected marker: " + content);
  },
};
