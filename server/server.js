require('dotenv').config({path:'../.env'});
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const nodemailer = require('nodemailer');
const path = require('path');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve frontend files
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/credentials.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'credentials.html'));
});

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Nodemailer transporter using Gmail
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_APP_PASSWORD,
  },
  pool: true,
  maxConnections: 3,
  maxMessages: 100,
  rateDelta: 1000,
  rateLimit: 5,
});

const EMAIL_FROM = process.env.EMAIL_FROM || process.env.EMAIL_USER;

transporter.verify((err) => {
  if (err) {
    console.error('Email transporter not ready:', err);
  } else {
    console.log('Email transporter ready');
  }
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const buildCredentialsEmail = ({ planType, username, password, reference }) => {
  const subject = 'Your Flint WiFi Access Details';
  const planLine = planType ? `<p style="margin:0 0 8px;">Plan: <strong>${planType}</strong></p>` : '';
  const refLine = reference ? `<p style="margin:0 0 8px;">Reference: <strong>${reference}</strong></p>` : '';

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;background:#f4f6f8;padding:24px;">
      <table width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;margin:0 auto;background:#ffffff;border-radius:8px;overflow:hidden;">
        <tr>
          <td style="padding:20px 24px;background:#0a3d62;color:#ffffff;">
            <h1 style="margin:0;font-size:20px;letter-spacing:0.3px;">Flint WiFi</h1>
          </td>
        </tr>
        <tr>
          <td style="padding:24px;">
            <p style="margin:0 0 12px;font-size:16px;">Hello,</p>
            <p style="margin:0 0 16px;color:#4a4a4a;">Your payment has been confirmed. Here are your WiFi access details:</p>
            ${planLine}
            ${refLine}
            <div style="border:1px solid #e6e8eb;border-radius:6px;padding:16px;background:#fafbfc;">
              <p style="margin:0 0 8px;font-size:14px;color:#666;">Username</p>
              <p style="margin:0 0 16px;font-size:18px;font-weight:bold;color:#0a3d62;">${username}</p>
              <p style="margin:0 0 8px;font-size:14px;color:#666;">Password</p>
              <p style="margin:0;font-size:18px;font-weight:bold;color:#0a3d62;">${password}</p>
            </div>
            <p style="margin:16px 0 0;color:#4a4a4a;">If you have any issues connecting, reply to this email and we will help.</p>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 24px;background:#f0f2f5;color:#7a7a7a;font-size:12px;">
            This email was sent by Flint WiFi.
          </td>
        </tr>
      </table>
    </div>
  `;

  const text = [
    'Hello,',
    '',
    'Your payment has been confirmed. Here are your WiFi access details:',
    planType ? `Plan: ${planType}` : null,
    reference ? `Reference: ${reference}` : null,
    `Username: ${username}`,
    `Password: ${password}`,
    '',
    'If you have any issues connecting, reply to this email and we will help.',
    '',
    'Flint WiFi'
  ].filter(Boolean).join('\n');

  return { subject, html, text };
};

const sendMailWithRetry = async (mailOptions, { retries = 2, delayMs = 1000 } = {}) => {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await transporter.sendMail(mailOptions);
    } catch (err) {
      lastError = err;
      if (attempt >= retries) throw err;
      const backoff = delayMs * Math.pow(2, attempt);
      await wait(backoff);
    }
  }
  throw lastError;
};

const sendCredentialsEmail = async ({ to, planType, username, password, reference }) => {
  const { subject, html, text } = buildCredentialsEmail({ planType, username, password, reference });
  return sendMailWithRetry(
    {
      from: `Flint WiFi <${EMAIL_FROM}>`,
      to,
      subject,
      html,
      text,
      replyTo: EMAIL_FROM,
    },
    { retries: 3, delayMs: 1000 }
  );
};

// API: Get available plans
app.get('/api/plans', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('Plans')
      .select('plan_type, amount, description, enabled')
      .order('amount', { ascending: true });

    if (error) throw error;
    res.json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});


// /api/init-payment  — PREP ONLY (Inline flow)
app.post('/api/init-payment', async (req, res) => {
  const { email, planType } = req.body;

  try {
    if (!process.env.PAYSTACK_PUBLIC_KEY) {
      console.error("PAYSTACK_PUBLIC_KEY not set");
      return res.status(500).json({ error: "Server misconfiguration" });
    }

    const { data: plan, error } = await supabase
      .from('Plans')
      .select('plan_type, amount, enabled')
      .eq('plan_type', planType)
      .single();

    if (error) return res.status(400).json({ error: "Database error" });
    if (!plan)  return res.status(400).json({ error: "Plan not found" });
    if (plan.enabled === false) {
      return res.status(403).json({ error: "This plan is currently disabled" });
    }

    const reference = `${planType}-${Math.floor(Math.random() * 1e9)}`;

    const payload = {
      key: process.env.PAYSTACK_PUBLIC_KEY,              // pk_test_* / pk_live_*
      email,
      amount: Math.round(plan.amount * 100),             // pesewas/kobo
      reference,
      split_code: process.env.PAYSTACK_SPLIT_CODE || null,
      metadata: { plan_type: planType, custom_reference: reference }
    };

    console.log("Inline init payload:", { reference, split_code: payload.split_code });
    res.json(payload);
  } catch (err) {
    console.error("Failed to prep payment:", err);
    res.status(500).json({ error: "Failed to prep payment" });
  }
});





// API: Verify payment & fetch WiFi credentials
app.post('/api/verify-payment', async (req, res) => {
  const { reference, email, planType, amount } = req.body;

  try {
    // Verify with Paystack
    const paystackResponse = await fetch(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        },
      }
    );
    const paystackData = await paystackResponse.json();

    if (!paystackData.status) {
      return res.status(400).json({ error: "Payment verification failed" });
    }

    const tx = paystackData.data;
    if (!tx || tx.status !== 'success') {
      return res.status(202).json({
        pending: true,
        message: `Payment is ${tx?.status || 'pending'}. Please retry verification shortly.`,
        reference
      });
    }

    // Fetch credentials from Supabase
    const { data: credentials, error: processError } = await supabase.rpc(
      'process_transaction_and_delete_login',
      {
        p_payment_ref: reference,
        p_customer_email: email,
        p_plan_type: planType,
        p_amount: amount
      }
    );

    if (processError) throw processError;

    // Send email with credentials
    try {
      const info = await sendCredentialsEmail({
        to: email,
        planType,
        username: credentials[0].username,
        password: credentials[0].password,
        reference
      });
      console.log('Email sent:', info.messageId);
    } catch (emailError) {
      console.error('Failed to send email:', emailError);
    }
    res.json({
      success: true,
      credentials: credentials[0],
      redirectUrl: `/credentials.html?username=${encodeURIComponent(credentials[0].username)}&password=${encodeURIComponent(credentials[0].password)}`
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// API: Manual verification (fallback)
app.post('/api/manual-verify', async (req, res) => {
  const { email, reference } = req.body;

  try {
    // --- Path A: reference provided (fast path) ---
    if (reference && reference.trim()) {
      // 1) Verify specific transaction on Paystack
      const verifyResp = await fetch(
        `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
        { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
      );
      const verifyData = await verifyResp.json();

      if (!verifyData.status || !verifyData.data) {
        return res.status(404).json({ error: "Payment not found for this reference" });
      }

      const tx = verifyData.data;

      // Only proceed on successful charge
      if (tx.status !== 'success') {
        return res.json({
          status: 'unprocessed',
          message: `Transaction is ${tx.status}.`,
          reference
        });
      }

      // 2) Avoid double-processing
      const { data: existingTx, error: txError } = await supabase
        .from('Transactions')
        .select('*')
        .eq('payment_reference', reference)
        .maybeSingle();

      if (txError) throw txError;
      if (existingTx) {
        return res.json({
          status: 'exists',
          message: "This payment was already processed",
          reference
        });
      }

      // 3) Derive plan & amount; prefer metadata, fallback to ref prefix
      const planType =
        tx.metadata?.plan_type ??
        (reference.includes('-') ? reference.split('-')[0] : null);

      const amount = tx.amount / 100;  // kobo/pesewas → base unit

      // Choose the best email: explicit body > Paystack customer email
      const customerEmail = email?.trim() || tx.customer?.email;
      if (!customerEmail) {
        return res.status(400).json({ error: "Could not determine customer email" });
      }
      if (!planType) {
        return res.status(400).json({ error: "Could not determine plan type" });
      }

      // 4) Process in Supabase (creates tx row, returns credentials, deletes login)
      const { data: credentials, error: processError } = await supabase.rpc(
        'process_transaction_and_delete_login',
        {
          p_payment_ref: reference,
          p_customer_email: customerEmail,
          p_plan_type: planType,
          p_amount: amount
        }
      );
      if (processError) throw processError;

      // 5) Email credentials
      try {
        const info = await sendCredentialsEmail({
          to: customerEmail,
          planType,
          username: credentials[0].username,
          password: credentials[0].password,
          reference
        });
        console.log('Email sent:', info.messageId);
      } catch (emailError) {
        console.error('Failed to send email:', emailError);
      }
      return res.json({
        status: 'processed',
        credentials: credentials?.[0],
        reference,
        message: "Payment processed successfully"
      });
    }

    // --- Path B: email-only flow (your current logic, unchanged except small cleanup) ---
    if (!email || !email.trim()) {
      return res.status(400).json({ error: "Provide a payment reference or your email" });
    }

    // Step 1: Fetch Paystack customer by email
    const customerResponse = await fetch(
      `https://api.paystack.co/customer/${encodeURIComponent(email)}`,
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );
    const customerData = await customerResponse.json();

    if (!customerData.status || !customerData.data) {
      return res.status(404).json({ error: "Customer not found on Paystack" });
    }

    const customerId = customerData.data.id;

    // Step 2: Fetch last 3 transactions for this customer
    const txResponse = await fetch(
      `https://api.paystack.co/transaction?customer=${customerId}&perPage=3`,
      { headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` } }
    );
    const txData = await txResponse.json();

    if (!txData.status || !txData.data || txData.data.length === 0) {
      return res.status(404).json({ error: "No transactions found for this customer" });
    }

    // Calculate date 2 days ago
    const twoDaysAgo = new Date();
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);

    // Step 3: Check recent successful, not-yet-processed tx
    for (const transaction of txData.data) {
      if (transaction.status !== 'success') continue;

      const transactionDate = new Date(transaction.paid_at || transaction.created_at);
      if (transactionDate < twoDaysAgo) continue;

      const { data: existingTx, error: txError } = await supabase
        .from('Transactions')
        .select('*')
        .eq('payment_reference', transaction.reference)
        .maybeSingle();

      if (txError) throw txError;
      if (existingTx) continue;

      const derivedPlanType =
        transaction.metadata?.plan_type ??
        (transaction.reference.includes('-') ? transaction.reference.split('-')[0] : null);
      const derivedAmount = transaction.amount / 100;

      const { data: credentials, error: processError } = await supabase.rpc(
        'process_transaction_and_delete_login',
        {
          p_payment_ref: transaction.reference,
          p_customer_email: email,
          p_plan_type: derivedPlanType,
          p_amount: derivedAmount
        }
      );
      if (processError) throw processError;

      try {
        const info = await sendCredentialsEmail({
          to: email,
          planType: derivedPlanType,
          username: credentials[0].username,
          password: credentials[0].password,
          reference: transaction.reference
        });
        console.log('Email sent:', info.messageId);
      } catch (emailError) {
        console.error('Failed to send email:', emailError);
      }
      return res.json({
        status: 'processed',
        credentials: credentials?.[0],
        reference: transaction.reference,
        message: "Payment processed successfully"
      });
    }

    // If no valid transactions found, check if processed recently
    const { data: recentProcessedTx } = await supabase
      .from('Transactions')
      .select('payment_reference, created_at')
      .eq('customer_email', email)
      .gte('created_at', twoDaysAgo.toISOString())
      .limit(1);

    if (recentProcessedTx && recentProcessedTx.length > 0) {
      return res.json({
        status: 'exists',
        message: "Your recent payment was already processed",
        reference: recentProcessedTx[0].payment_reference
      });
    }

    res.json({
      status: 'unprocessed',
      message: "No successful unprocessed payments found in the last 2 days",
      reference: null
    });
  } catch (err) {
    console.error('Manual verification error:', err);
    res.status(500).json({ error: "Manual verification failed" });
  }
});


// API: Retrieve credentials for processed payment
app.post('/api/retrieve-credentials', async (req, res) => {
  const { reference, email } = req.body;

  try {
    if (!reference || !reference.trim() || !email || !email.trim()) {
      return res.status(400).json({ error: "Reference and email are required" });
    }

    const normalizedReference = reference.trim();
    const normalizedEmail = email.trim();

    const { data: transaction, error: txError } = await supabase
      .from('Transactions')
      .select('*')
      .eq('payment_reference', normalizedReference)
      .eq('customer_email', normalizedEmail)
      .maybeSingle();

    if (txError) throw txError;

    if (!transaction) {
      return res.status(404).json({ error: "No payment found for that reference and email" });
    }

    const credentialUsername = transaction.credential_username || transaction.username;
    let username = credentialUsername;
    let password = transaction.credential_password || transaction.password;
    let planType = transaction.plan_type || transaction.planType;

    if (!username || !password) {
      const { data: soldLogin, error: soldError } = await supabase
        .from('SoldLogins')
        .select('username, password, plan_type')
        .eq('payment_reference', normalizedReference)
        .eq('customer_email', normalizedEmail)
        .maybeSingle();

      if (soldError) throw soldError;

      username = username || soldLogin?.username;
      password = password || soldLogin?.password;
      planType = planType || soldLogin?.plan_type;
    }

    if (!username || !password) {
      if (!credentialUsername) {
        return res.status(404).json({
          error: "Credentials are not available for this payment. Please contact support."
        });
      }

      const { data: login, error: loginError } = await supabase
        .from('Logins')
        .select('username, password')
        .eq('username', credentialUsername)
        .maybeSingle();

      if (loginError) throw loginError;

      username = username || login?.username;
      password = password || login?.password;
    }

    if (!username || !password) {
      return res.status(404).json({
        error: "Credentials are not available for this payment. Please contact support."
      });
    }

    res.json({
      success: true,
      credentials: { username, password },
      reference: normalizedReference
    });
  } catch (err) {
    console.error('Retrieve credentials error:', err);
    res.status(500).json({ error: "Failed to retrieve credentials" });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));

