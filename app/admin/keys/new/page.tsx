import { NewAccessKeyForm } from "@/components/new-access-key-form";

export default function NewAccessKeyPage() {
  return (
    <div className="max-w-lg">
      <h1 className="mb-1 text-2xl font-semibold text-white">New access key</h1>
      <p className="mb-6 text-sm text-zinc-500">
        Provision a Postal mail server and domain automatically, attach an existing Postal SMTP mailbox, relay
        through Devner, add Amazon SES credentials, attach a user&apos;s Elastic Email, Resend or Mailgun API key,
        set up Cloudflare Email Service (REST sending with optional Email Routing inbound), connect ZeptoMail
        (Zoho CPaaS) / custom SMTP credentials, or attach a Bird (MessageBird) API key.
      </p>
      <NewAccessKeyForm />
    </div>
  );
}