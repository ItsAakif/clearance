import nodemailer from 'nodemailer';
import { env, hasSmtpConfig } from '../config/env.js';

type EmailPayload = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

let transporterPromise: Promise<nodemailer.Transporter> | null = null;

async function createTransporter(): Promise<nodemailer.Transporter> {
  if (hasSmtpConfig()) {
    return nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: {
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
      },
    });
  }

  if (env.NODE_ENV === 'production') {
    throw new Error('SMTP configuration is required in production to send transactional email.');
  }

  const testAccount = await nodemailer.createTestAccount();
  return nodemailer.createTransport({
    host: testAccount.smtp.host,
    port: testAccount.smtp.port,
    secure: testAccount.smtp.secure,
    auth: {
      user: testAccount.user,
      pass: testAccount.pass,
    },
  });
}

async function getTransporter(): Promise<nodemailer.Transporter> {
  if (!transporterPromise) {
    transporterPromise = createTransporter();
  }

  return transporterPromise;
}

export async function sendTransactionalEmail(payload: EmailPayload): Promise<void> {
  const transporter = await getTransporter();
  const info = await transporter.sendMail({
    from: env.EMAIL_FROM,
    to: payload.to,
    subject: payload.subject,
    text: payload.text,
    html: payload.html,
  });

  const previewUrl = nodemailer.getTestMessageUrl(info);
  if (previewUrl) {
    console.log(`[Mailer] Preview URL: ${previewUrl}`);
  }
}
