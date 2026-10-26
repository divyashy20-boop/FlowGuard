import dotenv from "dotenv";
import path from "node:path";
dotenv.config({ path: path.resolve(__dirname, "../.env") });
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const tenant = await prisma.tenant.upsert({
    where: { id: "flowguard-demo-tenant" },
    update: {},
    create: { id: "flowguard-demo-tenant", name: "FlowGuard Demo Workspace" }
  });

  const email = "admin@flowguard.local";
  const password = process.env.SEED_ADMIN_PASSWORD;

  if (!password || password.length < 16) {
    throw new Error("Set SEED_ADMIN_PASSWORD to a strong local-only password (minimum 16 characters) before seeding.");
  }

  const user = await prisma.user.upsert({
    where: { email },
    update: { name: "FlowGuard Admin" },
    create: {
      email,
      name: "FlowGuard Admin",
      passwordHash: await bcrypt.hash(password, 12)
    }
  });

  await prisma.membership.upsert({
    where: { userId_tenantId: { userId: user.id, tenantId: tenant.id } },
    update: { role: "ADMIN", active: true },
    create: { userId: user.id, tenantId: tenant.id, role: "ADMIN" }
  });

  console.log(`Seeded ${email} in ${tenant.name}`);
}

main()
  .finally(async () => prisma.$disconnect())
  .catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
