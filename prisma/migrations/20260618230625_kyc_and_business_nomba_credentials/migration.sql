/*
  Warnings:

  - You are about to drop the column `bvn` on the `Customer` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "Business" ADD COLUMN     "nombaAccountId" TEXT,
ADD COLUMN     "nombaClientId" TEXT,
ADD COLUMN     "nombaClientSecret" TEXT,
ADD COLUMN     "nombaWebhookSecret" TEXT;

-- AlterTable
ALTER TABLE "Customer" DROP COLUMN "bvn",
ADD COLUMN     "bvnRef" TEXT,
ADD COLUMN     "kycVerificationProvider" TEXT,
ADD COLUMN     "kycVerificationRef" TEXT;
