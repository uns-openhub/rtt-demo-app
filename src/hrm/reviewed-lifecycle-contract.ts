import { createHash } from "node:crypto";
import { z } from "zod";
const pin = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const key = z
  .string()
  .regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/)
  .max(240);
const value = z.string().min(1).max(100);
const metadata = {
  schemaVersion: z.literal(1),
  label: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  status: z.literal("active").optional(),
  aliases: z.array(key).max(64).optional(),
  appliesTo: z.array(key).max(64).optional(),
};
const stateSchema = z
  .object({
    ...metadata,
    spec: z
      .object({
        values: z
          .array(
            z
              .object({
                key: value,
                label: z.string().min(1).max(200),
                description: z.string().max(4000).optional(),
                terminal: z.boolean().optional(),
              })
              .strict(),
          )
          .min(1)
          .max(64),
        initialValue: value,
        transitions: z
          .array(z.object({ from: value, to: value }).strict())
          .max(64),
      })
      .strict(),
  })
  .strict();
const actionSchema = z
  .object({
    ...metadata,
    spec: z
      .object({
        target: z.literal("entity"),
        stateTransitions: z
          .array(
            z
              .object({
                state: key,
                from: z.array(value).min(1).max(64),
                to: value,
              })
              .strict(),
          )
          .min(1)
          .max(64),
      })
      .strict(),
  })
  .strict();
export const reviewedContractSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("reviewed-demo-state-action"),
    scopeKey: z.literal("tenant:default"),
    packageId: key,
    packageVersion: z.string().min(1).max(64),
    reviewOperationId: z.string().uuid(),
    reviewDigest: pin,
    previousSnapshotDigest: pin,
    activeSnapshotDigest: pin,
    state: z.object({ key, definition: stateSchema }).strict(),
    actions: z
      .array(z.object({ key, definition: actionSchema }).strict())
      .min(1)
      .max(10),
    contractDigest: pin,
  })
  .strict();
export type ReviewedContract = z.infer<typeof reviewedContractSchema>;
function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v !== null && typeof v === "object")
    return (
      "{" +
      Object.entries(v)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => JSON.stringify(k) + ":" + canonical(x))
        .join(",") +
      "}"
    );
  return JSON.stringify(v) ?? "null";
}
export const runtimeDigest = (v: unknown) =>
  "sha256:" + createHash("sha256").update(canonical(v)).digest("hex");
export function parseReviewedContract(
  input: unknown,
  expectedDigest: string,
): ReviewedContract {
  const contract = reviewedContractSchema.parse(input),
    { contractDigest, ...base } = contract;
  if (
    contractDigest !== expectedDigest ||
    runtimeDigest(base) !== contractDigest
  )
    throw Error("Reviewed contract fingerprint mismatch.");
  const values = new Map(
    contract.state.definition.spec.values.map((v) => [v.key, v]),
  );
  if (
    values.size !== contract.state.definition.spec.values.length ||
    !values.has(contract.state.definition.spec.initialValue) ||
    new Set(contract.actions.map((a) => a.key)).size !== contract.actions.length
  )
    throw Error("Invalid reviewed state/Action identities.");
  for (const edge of contract.state.definition.spec.transitions)
    if (!values.has(edge.from) || !values.has(edge.to))
      throw Error("Unknown state edge.");
  for (const action of contract.actions)
    for (const edge of action.definition.spec.stateTransitions) {
      if (
        edge.state !== contract.state.key ||
        !values.has(edge.to) ||
        values.get(edge.to)!.terminal ||
        new Set(edge.from).size !== edge.from.length ||
        edge.from.some(
          (from) =>
            !values.has(from) ||
            !contract.state.definition.spec.transitions.some(
              (e) => e.from === from && e.to === edge.to,
            ),
        )
      )
        throw Error(
          "Action transition does not match the reviewed state model.",
        );
    }
  return contract;
}
