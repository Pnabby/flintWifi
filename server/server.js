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
});

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
      amount: 10 ,//Math.round(plan.amount * 100),             // pesewas/kobo
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
    const mailOptions = {
      from: `Flint WiFi <${process.env.EMAIL_FROM}>`,
      to: email,
      subject: 'Your WiFi Credentials',
      html: `
        <h1>Your WiFi Login Details</h1>
        <p>Plan: <strong>${planType}</strong></p>
        <p><strong>Username:</strong> ${credentials[0].username}</p>
        <p><strong>Password:</strong> ${credentials[0].password}</p>
        <br>
        <p>Thank you for choosing Flint WiFi!</p>
      `,
    };

    try {
      const info = await transporter.sendMail(mailOptions);
      console.log('? Email sent:', info.messageId);
    } catch (emailError) {
      console.error('? Failed to send email:', emailError);
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
    if (!reference || !reference.trim() || !email || !email.trim()) {
      return res.status(400).json({ error: "Provide both your payment reference and email" });
    }

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

    if (tx.customer?.email && tx.customer.email.toLowerCase() !== email.trim().toLowerCase()) {
      return res.status(400).json({ error: "Email does not match this payment reference" });
    }

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
      let existingCredentials = null;

      if (existingTx.credential_username) {
        const { data: soldLogin, error: soldError } = await supabase
          .from('SoldLogins')
          .select('username, password')
          .eq('username', existingTx.credential_username)
          .maybeSingle();

        if (soldError) throw soldError;
        if (soldLogin) {
          existingCredentials = {
            username: soldLogin.username,
            password: soldLogin.password
          };
        }
      }

      return res.json({
        status: 'exists',
        message: "This payment was already processed",
        reference,
        credentials: existingCredentials
      });
    }

    // 3) Derive plan & amount; prefer metadata, fallback to ref prefix
    const planType =
      tx.metadata?.plan_type ??
      (reference.includes('-') ? reference.split('-')[0] : null);

    const amount = tx.amount / 100;  // kobo/pesewas base unit

    if (!planType) {
      return res.status(400).json({ error: "Could not determine plan type" });
    }

    // 4) Process in Supabase (creates tx row, returns credentials, deletes login)
    const { data: credentials, error: processError } = await supabase.rpc(
      'process_transaction_and_delete_login',
      {
        p_payment_ref: reference,
        p_customer_email: email.trim(),
        p_plan_type: planType,
        p_amount: amount
      }
    );
    if (processError) throw processError;

    // 5) Email credentials
    const mailOptions = {
      from: `Flint WiFi <${process.env.EMAIL_FROM}>`,
      to: email.trim(),
      subject: 'Your WiFi Credentials',
      html: `
          <h1>Your WiFi Login Details</h1>
          <p>Plan: <strong>${planType}</strong></p>
          <p><strong>Username:</strong> ${credentials[0].username}</p>
          <p><strong>Password:</strong> ${credentials[0].password}</p>
          <br>
          <p>Thank you for choosing Flint WiFi!</p>
        `,
    };
    try {
      const info = await transporter.sendMail(mailOptions);
      console.log('? Email sent:', info.messageId);
    } catch (emailError) {
      console.error('? Failed to send email:', emailError);
    }

    return res.json({
      status: 'processed',
      credentials: credentials?.[0],
      reference,
      message: "Payment processed successfully"
    });
  } catch (err) {
    console.error('Manual verification error:', err);
    res.status(500).json({ error: "Manual verification failed" });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`? Server running on port ${PORT}`));


