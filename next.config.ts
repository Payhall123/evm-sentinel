import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // nodemailer (SMTP submission) is a Node-only CommonJS package with optional
  // dynamic requires. Keep it out of the server bundle so its internals resolve
  // at runtime instead of being traced/bundled by the compiler.
  serverExternalPackages: ["nodemailer"],
};

export default nextConfig;
