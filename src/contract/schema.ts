export const eventInputSchema = {
  type: "object",
  required: ["actor", "action", "resource"],
  additionalProperties: false,
  properties: {
    actor: { type: "string", minLength: 1 },
    action: { type: "string", minLength: 1 },
    resource: { type: "string", minLength: 1 },
    metadata: { type: "object" },
  },
} as const;

