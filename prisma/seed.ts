import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const email = (process.env.ADMIN_EMAIL || "admin@evmsentinel.io").toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    console.error("ADMIN_PASSWORD is not set. Set it before seeding.");
    process.exit(1);
  }
  const passwordHash = await bcrypt.hash(password, 12);
  const existing = await prisma.adminUser.findUnique({ where: { email } });
  if (existing) {
    await prisma.adminUser.update({ where: { id: existing.id }, data: { passwordHash } });
    console.log(`Admin ${email} updated.`);
  } else {
    await prisma.adminUser.create({ data: { email, passwordHash } });
    console.log(`Admin ${email} created.`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());