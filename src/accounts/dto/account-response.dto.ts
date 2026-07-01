/**
 * Typed response interfaces for the Accounts controller.
 * These mirror the API_SPEC.md response shapes for Swagger documentation.
 */

export class ProvisionAccountResponse {
  accountRef!: string;
  nombaAccountId!: string;
  accountNumber!: string;
  bankName!: string;
  accountNameAtCreation!: string;
  customerId!: string;
  status!: string;
  executionModel!: string;
  rules!: Array<{
    id: string;
    trigger: string;
    condition: Record<string, unknown>;
    action: string;
    priority: number;
    status: string;
    kycTierAtCreation: string;
  }>;
  createdAt!: string;
}

export class CloseAccountResponse {
  accountRef!: string;
  status!: string;
  pendingExecutionsArchived!: number;
  archivedRuleExecutionIds!: string[];
}
