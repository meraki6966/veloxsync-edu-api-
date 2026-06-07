// src/routes/edu-support.ts
// ============================================================
// VeloxSync for Education — Support Contact (public, no auth)
// ============================================================

import { Router, Request, Response } from 'express';
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY || '');
const FROM_EMAIL = process.env.FROM_EMAIL || 'onboarding@resend.dev';
const SUPPORT_EMAIL = 'support@veloxsync.app';

const router = Router();

// POST /api/edu/support/contact
router.post('/contact', async (req: Request, res: Response) => {
  const { name, email, subject, message } = req.body || {};

  if (!name || !email || !subject || !message) {
    return res.status(400).json({ error: 'name, email, subject, and message are required' });
  }

  // Send email (non-blocking — don't fail the response if email fails)
  try {
    await resend.emails.send({
      from: `VeloxSync Education <${FROM_EMAIL}>`,
      to: SUPPORT_EMAIL,
      replyTo: email,
      subject: `[VeloxSync Education Support] ${subject}`,
      text: [
        `Name: ${name}`,
        `Email: ${email}`,
        `Subject: ${subject}`,
        `Message: ${message}`,
      ].join('\n'),
    });
  } catch (emailErr: any) {
    console.error('[edu] support contact email failed:', emailErr.message);
  }

  res.json({ success: true, message: 'Message sent.' });
});

export default router;
