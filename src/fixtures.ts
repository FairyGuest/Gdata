import type { ClientRegistration } from "./contracts.ts";

export const FIXTURE_CLIENTS: ClientRegistration[] = [
  {
    clientId: "demo-client",
    clientSecret: "demo-secret",
    redirectUris: ["http://localhost:3000/callback", "http://127.0.0.1:3000/callback"],
  },
  {
    clientId: "fixture-client-b",
    clientSecret: "fixture-secret-b",
    redirectUris: ["https://app.example.com/oauth/callback"],
  },
];

export const FIXTURE_USERS = [
  { username: "alice", password: "alice-pass" },
  { username: "bob", password: "bob-pass" },
];
