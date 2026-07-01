/**
 * AccountOS — Rule Schema (Zod)
 *
 * This is the authoritative runtime-enforced definition of what a valid rule looks like.
 * The JSON examples in PRD.md are illustrative; this file is the actual contract.
 *
 * Per BUILD.md §5, every rule write path (POST /accounts, PUT /accounts/:ref/rules)
 * MUST call validateRuleSet() before touching Prisma. Invalid rules are rejected at
 * the API boundary — never discovered at execution time when a real payment arrives.
 *
 * MONEY: All amount values in conditions are in KOBO (integer).
 * ₦50,000 = 5,000,000 kobo. Enforce this with .int() on every amount field.
 *
 * DESIGN: A Rule is the intersection of two independently-discriminated unions —
 * "what triggers it" (trigger + condition) and "what it does" (action + payload).
 * Intersecting them lets any trigger pair with any action without hand-writing
 * every trigger×action combination.
 */

import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// Shared primitives
// ─────────────────────────────────────────────────────────────────────────────

export const KycTierSchema = z.enum(['TIER_0', 'TIER_1', 'TIER_2', 'TIER_3']);
export type KycTier = z.infer<typeof KycTierSchema>;

export const ExecutionModelSchema = z.enum(['SEQUENTIAL', 'PARALLEL']);
export type ExecutionModel = z.infer<typeof ExecutionModelSchema>;

/**
 * Priority for SEQUENTIAL execution ordering (EC-05).
 * Lower number = evaluated first. 0 = highest priority.
 */
const PrioritySchema = z.number().int().min(0).max(1000).default(0);

// ─────────────────────────────────────────────────────────────────────────────
// Trigger + Condition (discriminated by `trigger`)
//
// KOBO RULE: every amount field uses .int() — fractional kobo is impossible.
// ─────────────────────────────────────────────────────────────────────────────

const InflowConditionSchema = z
  .object({
    // All values in KOBO. ₦50,000 = 5_000_000 kobo.
    amount_gte: z.number().int().positive().optional(),
    amount_lte: z.number().int().positive().optional(),
    amount_lt: z.number().int().positive().optional(),
    amount_eq: z.number().int().positive().optional(),
    cumulative_gte: z.number().int().positive().optional(),
  })
  .refine((c) => Object.keys(c).length > 0, {
    message: 'inflow_received condition must specify at least one operator',
  });

const TimeElapsedConditionSchema = z
  .object({
    no_inflow_for_days: z.number().int().positive().optional(),
    // no_event_for_days + eventName: used for escrow dispute window (PRD §3.2)
    no_event_for_days: z.number().int().positive().optional(),
    eventName: z.string().min(1).optional(),
  })
  .refine(
    (c) =>
      c.no_inflow_for_days !== undefined || c.no_event_for_days !== undefined,
    {
      message:
        'time_elapsed condition requires no_inflow_for_days or no_event_for_days',
    },
  )
  .refine(
    (c) => c.no_event_for_days === undefined || c.eventName !== undefined,
    { message: 'no_event_for_days must be paired with eventName' },
  );

const TierChangedConditionSchema = z
  .object({
    fromTier: KycTierSchema.optional(),
    toTier: KycTierSchema.optional(),
  })
  .refine((c) => c.fromTier !== undefined || c.toTier !== undefined, {
    message: 'tier_changed condition requires fromTier and/or toTier',
  });

const CustomEventConditionSchema = z.object({
  eventName: z.string().min(1),
});

const TriggerConditionSchema = z.discriminatedUnion('trigger', [
  z.object({
    trigger: z.literal('inflow_received'),
    condition: InflowConditionSchema,
    priority: PrioritySchema,
  }),
  z.object({
    trigger: z.literal('time_elapsed'),
    condition: TimeElapsedConditionSchema,
    priority: PrioritySchema,
  }),
  z.object({
    trigger: z.literal('tier_changed'),
    condition: TierChangedConditionSchema,
    priority: PrioritySchema,
  }),
  z.object({
    trigger: z.literal('custom_event'),
    condition: CustomEventConditionSchema,
    priority: PrioritySchema,
  }),
]);

export type RuleTrigger = z.infer<typeof TriggerConditionSchema>['trigger'];

// ─────────────────────────────────────────────────────────────────────────────
// Action + Payload (discriminated by `action`)
// ─────────────────────────────────────────────────────────────────────────────

const NotifyWebhookPayloadSchema = z.object({
  url: z.string().url(),
});

const ReleaseFundsPayloadSchema = z
  .object({
    destinationAccountRef: z.string().min(1),
    /** Percentage of the triggering inflow amount (1–100). Mutually exclusive with amountKobo. */
    percentage: z.number().int().min(1).max(100).optional(),
    /** Exact amount in KOBO. Mutually exclusive with percentage. */
    amountKobo: z.number().int().positive().optional(),
  })
  .refine((p) => !(p.percentage !== undefined && p.amountKobo !== undefined), {
    message:
      'percentage and amountKobo are mutually exclusive — specify only one',
  });

const ActionPayloadSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('suspend_account') }),
  z.object({ action: z.literal('reactivate_account') }), // cyclic flows: SUSPENDED → ACTIVE (e.g. ajo monthly reset)
  z.object({ action: z.literal('expire_account') }),
  z.object({ action: z.literal('flag_for_review') }),
  z.object({
    action: z.literal('notify_webhook'),
    payload: NotifyWebhookPayloadSchema,
  }),
  z.object({
    action: z.literal('release_funds'),
    payload: ReleaseFundsPayloadSchema,
  }),
]);

export type RuleAction = z.infer<typeof ActionPayloadSchema>['action'];

// ─────────────────────────────────────────────────────────────────────────────
// Full Rule schema
// ─────────────────────────────────────────────────────────────────────────────

export const RuleSchema = z.intersection(
  TriggerConditionSchema,
  ActionPayloadSchema,
);
export type Rule = z.infer<typeof RuleSchema>;

export const RuleSetSchema = z.object({
  accountRef: z.string().min(1),
  executionModel: ExecutionModelSchema.default('SEQUENTIAL'),
  rules: z
    .array(RuleSchema)
    .min(1, 'a rule set must contain at least one rule'),
});
export type RuleSet = z.infer<typeof RuleSetSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Validation helper — call this before every Prisma rule write
// ─────────────────────────────────────────────────────────────────────────────

export interface RuleValidationResult {
  success: boolean;
  data?: RuleSet;
  /** Formatted as "path: message" — safe to return directly in a 400 response body. */
  errors?: string[];
}

export function validateRuleSet(input: unknown): RuleValidationResult {
  const result = RuleSetSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }
  return {
    success: false,
    errors: result.error.issues.map(
      (issue) => `${issue.path.join('.')}: ${issue.message}`,
    ),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Examples
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ajo/Esusu savings group (PRD §3.1)
 * All amounts in kobo: ₦50,000 = 5,000,000 kobo
 *
 * validateRuleSet({
 *   accountRef: 'ajo-group-04-member-012',
 *   executionModel: 'SEQUENTIAL',
 *   rules: [
 *     {
 *       trigger: 'inflow_received',
 *       condition: { amount_gte: 5000000 },   // ₦50,000
 *       action: 'suspend_account',
 *       priority: 0,
 *     },
 *     {
 *       trigger: 'inflow_received',
 *       condition: { cumulative_gte: 60000000 }, // ₦600,000 (12 members × ₦50,000)
 *       action: 'notify_webhook',
 *       payload: { url: 'https://yourbusiness.com/hooks/pot-complete' },
 *       priority: 1,
 *     },
 *   ],
 * });
 */

/**
 * Escrow / marketplace (PRD §3.2)
 *
 * validateRuleSet({
 *   accountRef: 'order-88213-escrow',
 *   executionModel: 'SEQUENTIAL',
 *   rules: [
 *     {
 *       trigger: 'custom_event',
 *       condition: { eventName: 'delivery_confirmed' },
 *       action: 'release_funds',
 *       payload: { destinationAccountRef: 'seller-4471' },
 *       priority: 0,
 *     },
 *     {
 *       trigger: 'custom_event',
 *       condition: { eventName: 'dispute_raised' },
 *       action: 'flag_for_review',
 *       priority: 1,
 *     },
 *     {
 *       trigger: 'time_elapsed',
 *       condition: { no_event_for_days: 7, eventName: 'dispute_raised' },
 *       action: 'release_funds',
 *       payload: { destinationAccountRef: 'seller-4471' },
 *       priority: 2,
 *     },
 *   ],
 * });
 */
