/*
  Warnings:

  - Added the required column `businessId` to the `Account` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('CUSTOMER_ACCOUNT', 'TREASURY_BUCKET');

-- CreateEnum
CREATE TYPE "BucketType" AS ENUM ('PAYROLL', 'TAX_RESERVE', 'OPERATIONS', 'MARKETING', 'SAVINGS', 'CUSTOM');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'TREASURY_BUCKET_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'TREASURY_BUCKET_CLOSED';
ALTER TYPE "AuditAction" ADD VALUE 'TREASURY_WITHDRAWAL_INITIATED';
ALTER TYPE "AuditAction" ADD VALUE 'TREASURY_WITHDRAWAL_COMPLETED';
ALTER TYPE "AuditAction" ADD VALUE 'TREASURY_WITHDRAWAL_FAILED';
ALTER TYPE "AuditAction" ADD VALUE 'ALLOCATE_FUNDS';

-- AlterTable
ALTER TABLE "Account" ADD COLUMN     "accountType" "AccountType" NOT NULL DEFAULT 'CUSTOMER_ACCOUNT',
ADD COLUMN     "bucketType" "BucketType",
ADD COLUMN     "businessId" TEXT NOT NULL,
ADD COLUMN     "description" TEXT,
ALTER COLUMN "customerId" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "Account_businessId_idx" ON "Account"("businessId");

-- CreateIndex
CREATE INDEX "Account_accountType_idx" ON "Account"("accountType");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "Business"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
