import { KycTier } from '@prisma/client';

export interface UpdateKycTierResult {
  customerId: string;
  previousTier: KycTier;
  newTier: KycTier;
  flaggedRuleIds: string[];
}
