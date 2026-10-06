// Usage: node scripts/create-admin.js "Owner Name" owner@example.com 'StrongPass123'
import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
const [name, email, password] = process.argv.slice(2);
if (!name || !email || !password || password.length < 8) {
  console.error('Usage: node scripts/create-admin.js "Name" email@example.com "StrongPass123" (min 8 chars)');
  process.exit(1);
}
const prisma = new PrismaClient();
const hash = await bcrypt.hash(password, 10);
const user = await prisma.user.upsert({
  where: { email: email.toLowerCase() },
  update: { password: hash, role: "ADMIN", mustChangePassword: false },
  create: { name, email: email.toLowerCase(), password: hash, role: "ADMIN" },
  select: { id: true, email: true, role: true },
});
console.log("Admin ready:", user);
await prisma.$disconnect();
