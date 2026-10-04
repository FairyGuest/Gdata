import { VirtualClock } from "../src/clock.ts";
import { TokenStore } from "../src/store.ts";
import { TokenService } from "../src/service.ts";

const clock = new VirtualClock(1_700_000_000_000);
const service = new TokenService(new TokenStore(":memory:"), clock, "demo-secret", "demo-run",
  (e) => console.log("[decision]", JSON.stringify(e)));

const issued = service.issue({ sub: "demo-user", scope: ["read"], ttlMs: 5_000 });
if (!issued.ok) throw new Error("issue failed");
console.log("issued:", issued.value.token);
console.log("validate:", JSON.stringify(service.validate(issued.value.token)));
const refreshed = service.refresh(issued.value.token);
console.log("refresh ok:", refreshed.ok);
console.log("old token after refresh:", JSON.stringify(service.validate(issued.value.token)));
clock.advance(6_000);
console.log("new token after clock advance:", JSON.stringify(
  refreshed.ok ? service.validate(refreshed.value.token) : refreshed
));